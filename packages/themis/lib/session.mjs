import { createPublicClient, http, parseAbi, encodeFunctionData, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBundlerClient, getUserOperationHash } from 'viem/account-abstraction';
import { sepolia } from 'viem/chains';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { remoteOwner } from './owner.mjs';
import { getEntryPoint, KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { deserializePermissionAccount, toPermissionValidator, serializePermissionAccount } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { toCallPolicy, toTimestampPolicy, toRateLimitPolicy, CallPolicyVersion, ParamCondition } from '@zerodev/permissions/policies';

export const chain = sepolia;
export const entryPoint = getEntryPoint('0.7');
export const kernelVersion = KERNEL_V3_3;
export const pool = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
export const usdc = '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8';
export const poolAbi = parseAbi([
  'function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)',
  'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
]);
export const tokenAbi = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
export function normalizeKey(raw) {
  if (typeof raw !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw.trim())) throw new Error('Invalid private key configuration.');
  return raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
}
// Called only after exact decimal validation; never use floating point for tokens.
export function units(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)) throw new Error('Invalid USDC amount.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
}
export function repayCall(account, amount) {
  return { to: pool, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: 'repay', args: [usdc, amount, 2n, account] }) };
}
export function buildPolicies(rules) {
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [{ target: pool, valueLimit: 0n, abi: poolAbi, functionName: 'repay', args: [
      { condition: ParamCondition.EQUAL, value: usdc },
      { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: units(rules.maxPerAction) },
      { condition: ParamCondition.EQUAL, value: 2n },
      { condition: ParamCondition.EQUAL, value: rules.account },
    ] }] }),
    toTimestampPolicy({ validAfter: rules.window.start, validUntil: rules.window.end }),
    toRateLimitPolicy({ count: rules.maxActions, interval: 0 }),
  ];
}
export async function restoreSession(client, serialized, sessionKey) {
  const signer = await toECDSASigner({ signer: privateKeyToAccount(normalizeKey(sessionKey)) });
  return deserializePermissionAccount(client, entryPoint, kernelVersion, serialized, signer);
}
// The owner path (Ledger) and the permission path (session key) over the same Kernel, built exactly the
// same way in prepare and finalize so the typed data and operation hash are identical in both.
async function authorizationParts(client, config, grant, signatures) {
  if (!config.ownerAddress) throw new Error('Owner address is not configured.');
  const owner = remoteOwner(config.ownerAddress, signatures);
  const validator = await signerToEcdsaValidator(client, { signer: owner.account, entryPoint, kernelVersion, validatorAddress: config.ownerValidator });
  const base = { entryPoint, kernelVersion, address: grant.rules.account, index: 0n };
  const ownerAccount = await createKernelAccount(client, { ...base, plugins: { sudo: validator } });
  if (ownerAccount.address.toLowerCase() !== grant.rules.account.toLowerCase()) throw new Error('Owner does not control the configured Kernel.');
  const signer = await toECDSASigner({ signer: privateKeyToAccount(normalizeKey(config.sessionKey)) });
  const policies = buildPolicies(grant.rules);
  const permission = await toPermissionValidator(client, { signer, policies, entryPoint, kernelVersion });
  const account = await createKernelAccount(client, { ...base, plugins: { sudo: validator, regular: permission } });
  return { owner, ownerAccount, account, permission, policies, signerAddress: signer.account.address };
}
export function createChainBackend(config) {
  const client = createPublicClient({ chain, transport: http(config.rpc, { retryCount: 0, timeout: 15000 }) });
  const relay = createBundlerClient({ chain, transport: http(config.bundler, { retryCount: 0, timeout: 15000 }) });
  return {
    client,
    async assertChain() { if (await client.getChainId() !== chain.id) throw new Error('Expected Ethereum Sepolia.'); },
    async now() { return Number((await client.getBlock()).timestamp); },
    // Phase 1: assemble the session permission and the owner's allowance approval; report what the owner must sign.
    async prepareAuthorization(grant) {
      const { owner, ownerAccount, account, permission, policies, signerAddress } = await authorizationParts(client, config, grant);
      await serializePermissionAccount(account); // asks the owner to sign the permission's enable data
      const ownerClient = createKernelAccountClient({ account: ownerAccount, client, chain, bundlerTransport: http(config.bundler, { retryCount: 0, timeout: 30000 }) });
      const amount = units(grant.rules.maxPerAction) * BigInt(grant.rules.maxActions);
      const prepared = await ownerClient.prepareUserOperation({ calls: [{ to: usdc, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [pool, amount] }) }] });
      const { signature: _stub, calls: _calls, account: _account, ...operation } = prepared;
      await ownerAccount.signUserOperation(operation); // asks the owner to sign the operation hash
      const hash = getUserOperationHash({ userOperation: operation, chainId: chain.id, entryPointAddress: entryPoint.address, entryPointVersion: '0.7' });
      return { operation, hash, requests: owner.requests(), amount, owner: config.ownerAddress, sessionKey: signerAddress, permissionId: permission.getIdentifier(), ratePolicy: `0x${policies[2].getPolicyInfoInBytes().slice(-40)}` };
    },
    // Phase 2: rebuild the identical objects, apply the owner's signatures, and return the sendable operation.
    async finalizeAuthorization(grant, prepared, signatures) {
      const { ownerAccount, account, permission, policies } = await authorizationParts(client, config, grant, signatures);
      const serialized = await serializePermissionAccount(account);
      const operation = { ...prepared.operation };
      operation.signature = await ownerAccount.signUserOperation(operation);
      const hash = getUserOperationHash({ userOperation: operation, chainId: chain.id, entryPointAddress: entryPoint.address, entryPointVersion: '0.7' });
      if (hash !== prepared.hash) throw new Error('Prepared operation changed.');
      return { operation, hash, serialized, permissionId: permission.getIdentifier(), ratePolicy: `0x${policies[2].getPolicyInfoInBytes().slice(-40)}` };
    },
    async snapshot(grant) {
      const id = pad(grant.permissionId, { size: 32, dir: 'right' });
      const rateAbi = parseAbi(['function status(bytes32,address) view returns (uint8)', 'function rateLimitConfigs(bytes32,address) view returns (uint48,uint48,uint48)']);
      const [block, allowance, balance, position, status, rate] = await Promise.all([
        client.getBlock(),
        client.readContract({ address: usdc, abi: tokenAbi, functionName: 'allowance', args: [grant.rules.account, pool] }),
        client.readContract({ address: usdc, abi: tokenAbi, functionName: 'balanceOf', args: [grant.rules.account] }),
        client.readContract({ address: pool, abi: poolAbi, functionName: 'getUserAccountData', args: [grant.rules.account] }),
        client.readContract({ address: grant.ratePolicy, abi: rateAbi, functionName: 'status', args: [id, grant.rules.account] }),
        client.readContract({ address: grant.ratePolicy, abi: rateAbi, functionName: 'rateLimitConfigs', args: [id, grant.rules.account] }),
      ]);
      return { now: Number(block.timestamp), allowance, balance, debt: position[1], remaining: status === 0 ? grant.rules.maxActions : status === 1 ? rate[1] : 0 };
    },
    async prepare(grant, intent) {
      const account = await restoreSession(client, grant.serialized, config.sessionKey);
      if (account.address.toLowerCase() !== grant.rules.account.toLowerCase()) throw new Error('Session/account mismatch.');
      const bundler = createKernelAccountClient({ account, client, chain, bundlerTransport: http(config.bundler, { retryCount: 0, timeout: 15000 }) });
      const prepared = await bundler.prepareUserOperation({ calls: [repayCall(account.address, units(intent.amount))] });
      const { signature: _stub, calls: _calls, account: _account, ...operation } = prepared;
      operation.signature = await account.signUserOperation(operation);
      const hash = getUserOperationHash({ userOperation: operation, chainId: chain.id, entryPointAddress: entryPoint.address, entryPointVersion: '0.7' });
      return { operation, hash };
    },
    // No account on this client: send the already-signed operation unchanged.
    async broadcast(prepared) {
      const hash = await relay.sendUserOperation({ ...prepared.operation, entryPointAddress: entryPoint.address });
      if (hash.toLowerCase() !== prepared.hash.toLowerCase()) throw new Error('Bundler returned an unexpected operation hash.');
    },
    async receipt(hash) {
      try { return await relay.getUserOperationReceipt({ hash }); }
      catch (error) { if (error.name === 'UserOperationReceiptNotFoundError') return null; throw error; }
    },
  };
}
