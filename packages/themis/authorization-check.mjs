// Offline proof that the Ledger authorization flow produces operations the chain accepts, without a Ledger
// and without sending anything. Digests are signed by the dev key, and the simulation temporarily treats
// the dev key as the Kernel's owner via a storage override; the signatures have exactly the shape a Ledger's
// personal-sign and typed-data signatures have.
//   node authorization-check.mjs
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256, encodeAbiParameters, decodeAbiParameters, pad, decodeEventLog, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount, sign, serializeSignature } from 'viem/accounts';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { config } from './lib/config.mjs';
import { createChainBackend, restoreSession, entryPoint, normalizeKey, usdc, pool, tokenAbi, repayCall, chain } from './lib/session.mjs';

loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const dev = privateKeyToAccount(normalizeKey(process.env.DEV_OWNER_PRIVATE_KEY));
const cfg = { ...config(), ownerAddress: dev.address }; // build the owner path around the dev key for this check
const real = config().ownerAddress;
const client = createPublicClient({ chain, transport: http(cfg.rpc, { retryCount: 0, timeout: 20000 }) });
const backend = createChainBackend(cfg);
const kernel = cfg.account;
const now = await backend.now();
const grant = { id: 'check', rules: { account: kernel, chainId: 11155111, window: { start: now, end: now + 3600 }, trigger: { healthFactorBelow: 1.15 }, allow: [{ protocol: 'aave-v3', action: 'repay', asset: 'USDC' }], maxPerAction: '1', maxActions: 3 } };

const prepared = await backend.prepareAuthorization(grant);
console.log('Owner must sign:', prepared.requests.map(request => `${request.kind} ${request.id.slice(0, 12)}…`).join(', '));
if (prepared.requests.length !== 2) throw new Error('Expected one typed-data and one message request.');
const signatures = Object.fromEntries(await Promise.all(prepared.requests.map(async request => [request.id, serializeSignature(await sign({ hash: request.id, privateKey: normalizeKey(process.env.DEV_OWNER_PRIVATE_KEY) }))])));
const finalized = await backend.finalizeAuthorization(grant, prepared, signatures);
console.log('Finalized: operation signed, permission serialized, id', finalized.permissionId);

// The validator keeps owners in `mapping(address => owner)` at slot 0.
const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [kernel, 0n]));
const validatorAddress = cfg.ownerValidator;
const stored = await client.getStorageAt({ address: validatorAddress, slot });
console.log(`Storage slot holds ${`0x${stored.slice(26)}`} (configured owner ${real})`);
if (`0x${stored.slice(26)}`.toLowerCase() !== real.toLowerCase()) throw new Error('Owner storage slot assumption is wrong.');

// Session-key repay that must use the enable signature (permission not yet installed on-chain).
const session = await restoreSession(client, finalized.serialized, cfg.sessionKey);
const fees = await client.estimateFeesPerGas();
// Enable-mode validation installs the permission's policies and needs well over 4M verification gas. The fee is
// token-small only so the Kernel's ETH covers the prefund in simulation; real operations get bundler estimates.
const gas = { callGasLimit: 300000n, verificationGasLimit: BigInt(process.env.VGAS || 6000000), preVerificationGas: 100000n, maxFeePerGas: BigInt(process.env.MAXFEE || 2), maxPriorityFeePerGas: BigInt(process.env.MAXFEE ? 0 : 1) };
// Nonce of the session operation is read live; the approve operation does not touch it.
const repay = { sender: kernel, nonce: await session.getNonce(), callData: await session.encodeCalls([repayCall(kernel, 1000000n)]), ...gas };
repay.signature = await session.signUserOperation(repay);

const simulated = await client.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{
  stateOverrides: { [validatorAddress]: { stateDiff: { [slot]: pad(dev.address, { size: 32 }) } } },
  calls: [
    { from: dev.address, to: entryPoint.address, gas: '0x2dc6c0', data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[toPackedUserOperation(finalized.operation)], dev.address] }) },
    { to: usdc, data: encodeFunctionData({ abi: tokenAbi, functionName: 'allowance', args: [kernel, pool] }) },
    { from: dev.address, to: entryPoint.address, gas: '0x1c9c380', data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[toPackedUserOperation(repay)], dev.address] }) },
  ] }], validation: false }, 'latest'] });
const [approve, allowance, handledRepay] = simulated[0].calls;
const outcome = call => (call.logs || []).map(log => { try { return decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics }); } catch { return null; } }).find(event => event?.eventName === 'UserOperationEvent');
console.log('Owner approve operation:', approve.status === '0x1' && outcome(approve)?.args.success ? 'executes' : `FAILED ${JSON.stringify(approve.error || approve.returnData)?.slice(0, 200)}`);
console.log('Allowance after approve :', BigInt(allowance.returnData), '(expected', prepared.amount, ')');
console.log('Session repay (enable)  :', handledRepay.status === '0x1' && outcome(handledRepay)?.args.success ? 'executes' : `FAILED ${(() => { try { const [i, reason, inner] = decodeAbiParameters([{ type: 'uint256' }, { type: 'string' }, { type: 'bytes' }], `0x${handledRepay.error.data.slice(10)}`); return `op${i}: ${reason}; inner ${inner}`; } catch (e) { return JSON.stringify(handledRepay.error); } })()}`);

if (!(handledRepay.status === '0x1' && outcome(handledRepay)?.args.success)) {
  // Call the Kernel's validateUserOp as the EntryPoint would, to see the real revert behind AA23.
  const { getUserOperationHash } = await import('viem/account-abstraction');
  const hash = getUserOperationHash({ userOperation: repay, chainId: chain.id, entryPointAddress: entryPoint.address, entryPointVersion: '0.7' });
  const validateAbi = parseAbi(['function validateUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp,bytes32 userOpHash,uint256 missingAccountFunds) returns (uint256)']);
  const probe = await client.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{
    stateOverrides: { [validatorAddress]: { stateDiff: { [slot]: pad(dev.address, { size: 32 }) } } },
    calls: [
      { from: dev.address, to: entryPoint.address, gas: '0x2dc6c0', data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[toPackedUserOperation(finalized.operation)], dev.address] }) },
      { from: entryPoint.address, to: kernel, gas: '0x4c4b40', data: encodeFunctionData({ abi: validateAbi, functionName: 'validateUserOp', args: [toPackedUserOperation(repay), hash, BigInt(process.env.MISSING || 0)] }) },
    ] }], validation: false, traceTransfers: false }, 'latest'] });
  const direct = probe[0].calls[1];
  console.log('Direct validateUserOp:', direct.status, JSON.stringify(direct.error || direct.returnData));
  console.log('Session signature length (bytes):', (repay.signature.length - 2) / 2, '| first byte', repay.signature.slice(0, 4));
}

if (process.env.DIAG) {
  // Same operation through a plain eth_call with only the owner-slot override (no preceding approve operation).
  try {
    await client.simulateContract({ account: dev, address: entryPoint.address, abi: entryPoint07Abi, functionName: 'handleOps', args: [[toPackedUserOperation(repay)], dev.address], gas: 25000000n, stateOverride: [{ address: validatorAddress, stateDiff: [{ slot, value: pad(dev.address, { size: 32 }) }] }] });
    console.log('Plain eth_call handleOps: OK');
  } catch (error) { console.log('Plain eth_call handleOps:', (error.cause?.data?.errorName || error.shortMessage), String(JSON.stringify(error.cause?.data?.args, (_, v) => typeof v === 'bigint' ? v.toString() : v)).slice(0, 300)); }
}
