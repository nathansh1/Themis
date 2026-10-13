import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits,
  formatEther, encodeFunctionData, decodeErrorResult, toFunctionSelector, pad,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toPermissionValidator, serializePermissionAccount } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { buildPolicies, restoreSession, repayCall as buildRepayCall } from './lib/session.mjs';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
loadEnvFile(envPath);
const statePath = fileURLToPath(new URL('./a2-state.json', import.meta.url));
const privateDir = fileURLToPath(new URL('./.local/', import.meta.url));
const permissionPath = `${privateDir}session-permission.json`;
const a1 = JSON.parse(readFileSync(new URL('./a1-state.json', import.meta.url), 'utf8'));
const { account: kernelAddress, pool, usdc, weth } = a1;
const entryPoint = getEntryPoint('0.7');
const cap = parseUnits('1', 6);
const allowanceCap = cap * 3n;
const command = process.argv[2] || 'status';
const send = process.argv.includes('--send');
const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
]);
const poolAbi = parseAbi([
  'function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)',
  'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
]);
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
const save = () => writeFileSync(statePath, JSON.stringify(state, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { mode: 0o600 });
function key(name) {
  const raw = process.env[name]?.trim();
  if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`Set a valid ${name} locally in .env.`);
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}
function requireNoPending() {
  if (state?.transactions.some(tx => tx.status === 'pending')) throw new Error('Resolve the saved pending transaction before sending again.');
}
const transport = () => http(process.env.SEPOLIA_RPC_URL, { retryCount: 0, timeout: 20000 });
const client = createPublicClient({ chain: sepolia, transport: transport() });
const kernelClient = account => createKernelAccountClient({ account, client, chain: sepolia, bundlerTransport: http(process.env.ZERODEV_BUNDLER_RPC, { retryCount: 0, timeout: 30000 }) });
const readAllowance = () => client.readContract({ address: usdc, abi: tokenAbi, functionName: 'allowance', args: [kernelAddress, pool] });
const readPosition = () => client.readContract({ address: pool, abi: poolAbi, functionName: 'getUserAccountData', args: [kernelAddress] });
const balance = address => client.readContract({ address: usdc, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
async function remainingOperations() {
  const policy = state?.policies?.find(item => item.type === 'rate-limit');
  if (!policy || !state.repayment) return null;
  // Solidity extends bytes4 permission IDs to bytes32 by padding on the right.
  const config = await client.readContract({
    address: policy.address,
    abi: parseAbi(['function rateLimitConfigs(bytes32,address) view returns (uint48 interval,uint48 count,uint48 startAt)']),
    functionName: 'rateLimitConfigs', args: [pad(state.permissionId, { size: 32, dir: 'right' }), kernelAddress],
  });
  if (config[0] !== 0) throw new Error('Installed rate-limit interval differs from the authorized policy.');
  return config[1];
}
const repayCall = (amount = cap, asset = usdc, beneficiary = kernelAddress, rate = 2n) =>
  asset === usdc && beneficiary === kernelAddress && rate === 2n ? buildRepayCall(kernelAddress, amount) :
    { to: pool, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: 'repay', args: [asset, amount, rate, beneficiary] }) };

async function sendOperation(label, account, calls) {
  requireNoPending();
  const bundler = kernelClient(account);
  const prepared = await bundler.prepareUserOperation({ calls });
  // Never submit the placeholder signature returned by gas estimation.
  const { signature: _stub, ...unsigned } = prepared;
  const hash = await bundler.sendUserOperation(unsigned);
  const tx = { label, userOpHash: hash, status: 'pending' };
  state.transactions.push(tx); save();
  console.log(`${label} UserOperation: ${hash}`);
  const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 120000 });
  Object.assign(tx, { status: receipt.success ? 'success' : 'reverted', txHash: receipt.receipt.transactionHash }); save();
  console.log(`${label}: https://sepolia.etherscan.io/tx/${tx.txHash}`);
  if (!receipt.success) throw new Error(`${label} execution reverted.`);
  return tx;
}

async function ownerAccount() {
  const owner = privateKeyToAccount(key('DEV_OWNER_PRIVATE_KEY'));
  if (owner.address.toLowerCase() !== a1.owner.toLowerCase()) throw new Error('Owner key does not match A1.');
  const validator = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const account = await createKernelAccount(client, { plugins: { sudo: validator }, entryPoint, kernelVersion: KERNEL_V3_3, index: 0n });
  if (account.address.toLowerCase() !== kernelAddress.toLowerCase()) throw new Error('Derived Kernel differs from A1.');
  return { owner, validator, account };
}

async function setup() {
  const { validator, account } = await ownerAccount();
  if (!send) {
    console.log(`Kernel ${kernelAddress}: plan is repay USDC only, <=1 USDC/call, 3 UserOperations total, 8 hours, 3 USDC allowance. Use setup --send to authorize.`);
    return;
  }
  requireNoPending();
  if (!process.env.SESSION_PRIVATE_KEY?.trim()) {
    if (state) throw new Error('Existing A2 state has no session key; restore its key instead of generating another.');
    const secret = generatePrivateKey();
    const text = readFileSync(envPath, 'utf8');
    const pattern = /^\s*SESSION_PRIVATE_KEY\s*=.*$/gm;
    if ([...text.matchAll(pattern)].length > 1) throw new Error('Multiple SESSION_PRIVATE_KEY definitions found.');
    const next = pattern.test(text) ? text.replace(/^\s*SESSION_PRIVATE_KEY\s*=.*$/gm, `SESSION_PRIVATE_KEY=${secret}`) : `${text.trimEnd()}\nSESSION_PRIVATE_KEY=${secret}\n`;
    writeFileSync(envPath, next, { mode: 0o600 }); chmodSync(envPath, 0o600);
    process.env.SESSION_PRIVATE_KEY = secret;
    console.log('Generated session key in local .env; private value is not printed.');
  }
  const signerAccount = privateKeyToAccount(key('SESSION_PRIVATE_KEY'));
  if (signerAccount.address.toLowerCase() === a1.owner.toLowerCase()) throw new Error('Session and owner must use different keys.');
  const now = Number((await client.getBlock()).timestamp);
  if (!state) {
    state = { account: kernelAddress, chainId: sepolia.id, sessionAddress: signerAccount.address, validAfter: now - 60, validUntil: now + 8 * 3600, maxPerCall: '1', maxUserOperations: 3, totalAllowance: '3', transactions: [] };
    save();
  }
  if (state.sessionAddress !== signerAccount.address || state.account !== kernelAddress) throw new Error('A2 state does not match this account/key.');
  if (now >= state.validUntil) throw new Error('Saved session expired; do not silently renew it.');
  if (state.permissionSaved) { console.log('Permission already authorized; existing allowance is not reset.'); return; }
  const signer = await toECDSASigner({ signer: signerAccount });
  const policies = buildPolicies({ account: kernelAddress, maxPerAction: '1', maxActions: 3, window: { start: state.validAfter, end: state.validUntil } });
  for (const policy of policies) {
    const address = `0x${policy.getPolicyInfoInBytes().slice(-40)}`;
    if (!await client.getCode({ address })) throw new Error(`Policy contract missing: ${address}`);
  }
  const permission = await toPermissionValidator(client, { signer, policies, entryPoint, kernelVersion: KERNEL_V3_3 });
  const authorized = await createKernelAccount(client, { plugins: { sudo: validator, regular: permission }, entryPoint, kernelVersion: KERNEL_V3_3, index: 0n });
  if (authorized.address.toLowerCase() !== kernelAddress.toLowerCase()) throw new Error('Permission attached to an unexpected account.');
  // This owner signature authorizes the permission. No private key is serialized.
  const serialized = await serializePermissionAccount(authorized);
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  writeFileSync(permissionPath, JSON.stringify({ serialized }) + '\n', { mode: 0o600 }); chmodSync(permissionPath, 0o600);
  if (!state.transactions.some(tx => tx.label === 'Owner approve 3 USDC' && tx.status === 'success')) {
    await sendOperation('Owner approve 3 USDC', account, [{ to: usdc, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [pool, allowanceCap] }) }]);
  }
  if (await readAllowance() !== allowanceCap) throw new Error('Allowance is not exactly 3 USDC.');
  Object.assign(state, { permissionSaved: true, permissionId: permission.getIdentifier(), policies: policies.map(policy => ({ type: policy.policyParams.type, address: `0x${policy.getPolicyInfoInBytes().slice(-40)}` })) }); save();
  console.log(`Session ${state.sessionAddress} authorized until ${new Date(state.validUntil * 1000).toISOString()}. First session operation installs the policies on-chain.`);
}

async function sessionAccount() {
  if (!state?.permissionSaved) throw new Error('Run setup --send first.');
  const signer = await toECDSASigner({ signer: privateKeyToAccount(key('SESSION_PRIVATE_KEY')) });
  if (signer.account.address !== state.sessionAddress) throw new Error('Session key differs from saved authorization.');
  // Deliberately no owner validator: the saved authorization and session key suffice.
  const { serialized } = JSON.parse(readFileSync(permissionPath, 'utf8'));
  const account = await restoreSession(client, serialized, key('SESSION_PRIVATE_KEY'));
  if (account.address.toLowerCase() !== kernelAddress.toLowerCase()) throw new Error('Serialized account differs from A1.');
  return account;
}

async function repay() {
  const account = await sessionAccount();
  if (state.transactions.some(tx => tx.label === 'Session repay 1 USDC' && tx.status === 'success')) { console.log('A2 repayment already confirmed; skipping duplicate.'); return; }
  const [before, allowance, position] = await Promise.all([balance(kernelAddress), readAllowance(), readPosition()]);
  if (before < cap || allowance < cap || position[1] === 0n) throw new Error('Repayment requires a USDC balance, allowance and outstanding debt.');
  await kernelClient(account).prepareUserOperation({ calls: [repayCall()] });
  console.log('Session-only repayment simulation passed.');
  if (!send) return;
  await sendOperation('Session repay 1 USDC', account, [repayCall()]);
  const [after, allowanceAfter, positionAfter] = await Promise.all([balance(kernelAddress), readAllowance(), readPosition()]);
  if (before - after !== cap || allowance - allowanceAfter !== cap || positionAfter[1] >= position[1]) throw new Error('Repayment receipt did not match the expected balance, allowance and debt changes.');
  state.repayment = { amount: '1', balanceBefore: before, balanceAfter: after, allowanceAfter, debtBaseBefore: position[1], debtBaseAfter: positionAfter[1], healthFactor: formatEther(positionAfter[5]) }; save();
  console.log(`Confirmed 1 USDC repayment. Remaining allowance ${formatUnits(allowanceAfter, 6)} USDC; health factor ${formatEther(positionAfter[5])}.`);
}

// Decode revert bytes, not arbitrary error text or network failures, as evidence.
function policyRevert(error) {
  let cursor = error;
  while (cursor) {
    const data = cursor.data;
    if (typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data)) {
      try {
        const decoded = decodeErrorResult({ abi: entryPoint07Abi, data });
        if (decoded.errorName === 'FailedOpWithRevert') {
          const inner = decoded.args[2];
          for (const name of ['InvalidCallData', 'CallViolatesParamRule', 'CallViolatesValueRule', 'InvalidCallType']) {
            if (inner.toLowerCase().includes(toFunctionSelector(`${name}()`).slice(2).toLowerCase())) return { entryPointError: decoded.errorName, reason: decoded.args[1], policyError: name, revertData: data };
          }
        }
      } catch { /* Keep looking through structured causes. */ }
    }
    cursor = cursor.cause;
  }
  return null;
}

async function attack() {
  const account = await sessionAccount();
  if (!state.repayment) throw new Error('Complete the session repayment before testing rejection.');
  if (state.attack?.status === 'reverted') { console.log('Attack already mined and rejected; see a2-state.json.'); return; }
  requireNoPending();
  const { owner } = await ownerAccount();
  // The owner EOA relays handleOps, but the UserOperation is signed ONLY by the
  // session key. A relay transaction from the owner does not authorize Kernel.
  const attacker = privateKeyToAccount(generatePrivateKey()).address;
  const valid = await kernelClient(account).prepareUserOperation({ calls: [repayCall()] });
  const { signature: _stub, calls: _calls, ...base } = valid;
  async function signed(calls) {
    const operation = { ...base, callData: await account.encodeCalls(calls) };
    operation.signature = await account.signUserOperation(operation);
    return toPackedUserOperation(operation);
  }
  async function simulate(packed) {
    return client.simulateContract({ account: owner, address: entryPoint.address, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed], owner.address], gas: 3000000n });
  }
  await simulate(await signed([repayCall()]));
  console.log('Positive control: a correctly signed allowed UserOperation passes EntryPoint validation.');
  const transfer = { to: usdc, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [attacker, cap] }) };
  const scenarios = [
    ['transfer', [transfer], 'InvalidCallData'],
    ['over_per_call_limit', [repayCall(cap + 1n)], 'CallViolatesParamRule'],
    ['wrong_asset', [repayCall(cap, weth)], 'CallViolatesParamRule'],
    ['wrong_beneficiary', [repayCall(cap, usdc, attacker)], 'CallViolatesParamRule'],
    ['wrong_rate_mode', [repayCall(cap, usdc, kernelAddress, 1n)], 'CallViolatesParamRule'],
    ['approve', [{ to: usdc, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [attacker, cap] }) }], 'InvalidCallData'],
    ['mixed_batch', [repayCall(), transfer], 'InvalidCallData'],
  ];
  let transferPacked;
  state.validationTests = [];
  for (const [name, calls, expectedError] of scenarios) {
    const packed = await signed(calls);
    let rejection;
    try { await simulate(packed); } catch (error) { rejection = policyRevert(error); if (!rejection) throw error; }
    if (!rejection || rejection.policyError !== expectedError) throw new Error(`${name} did not produce the expected policy rejection.`);
    state.validationTests.push({ name, ...rejection });
    console.log(`${name}: rejected by ${rejection.policyError}`);
    if (name === 'transfer') transferPacked = packed;
  }
  save();
  if (!send) { console.log('All attack simulations rejected as expected. Use attack --send to mine the transfer rejection.'); return; }
  const before = { attacker: await balance(attacker), kernel: await balance(kernelAddress), allowance: await readAllowance() };
  const wallet = createWalletClient({ account: owner, chain: sepolia, transport: transport() });
  const fees = await client.estimateFeesPerGas();
  const gas = 3000000n;
  if (await client.getBalance({ address: owner.address }) < gas * fees.maxFeePerGas) throw new Error('Relayer lacks test ETH for attack-proof gas.');
  // Explicit gas bypasses estimation of this intentionally reverting transaction.
  const hash = await wallet.sendTransaction({ to: entryPoint.address, data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[transferPacked], owner.address] }), gas, ...fees });
  const tx = { label: 'Direct session transfer attack', txHash: hash, status: 'pending' };
  state.transactions.push(tx); save();
  console.log(`Attack proof: https://sepolia.etherscan.io/tx/${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
  tx.status = receipt.status; save();
  if (receipt.status !== 'reverted') throw new Error('SECURITY FAILURE: attack transaction did not revert.');
  // Replay against the preceding block to verify the mined failure reason too.
  let rejection;
  try {
    await client.simulateContract({ account: owner, address: entryPoint.address, abi: entryPoint07Abi, functionName: 'handleOps', args: [[transferPacked], owner.address], gas, blockNumber: receipt.blockNumber - 1n });
  } catch (error) { rejection = policyRevert(error); if (!rejection) throw error; }
  if (rejection?.policyError !== 'InvalidCallData') throw new Error('Mined rejection was not attributable to the call policy.');
  if (await balance(attacker) !== before.attacker || await balance(kernelAddress) !== before.kernel || await readAllowance() !== before.allowance) throw new Error('Token balances or allowance changed during the attack.');
  state.attack = { status: 'reverted', txHash: hash, attacker, amount: '1', ...rejection, balancesUnchanged: true, blockNumber: receipt.blockNumber };
  save();
  console.log('A2 proof complete: session repayment succeeded; direct transfer reverted on-chain with InvalidCallData and unchanged token balances.');
}

async function main() {
  if (!['setup', 'repay', 'attack', 'status'].includes(command)) throw new Error('Use setup, repay, attack or status; add --send to submit.');
  if (!process.env.SEPOLIA_RPC_URL || !process.env.ZERODEV_BUNDLER_RPC) throw new Error('RPC configuration is missing.');
  if (a1.chainId !== sepolia.id || a1.kernelVersion !== KERNEL_V3_3 || await client.getChainId() !== sepolia.id) throw new Error('Expected the A1 Kernel 0.3.3 account on Sepolia.');
  if (state && state.account !== kernelAddress) throw new Error('A2 state does not match A1.');
  if (command === 'setup') return setup();
  if (command === 'repay') return repay();
  if (command === 'attack') return attack();
  const [allowance, position, remaining, block] = await Promise.all([readAllowance(), readPosition(), remainingOperations(), client.getBlock()]);
  console.log(JSON.stringify({ kernel: kernelAddress, session: state?.sessionAddress, validUntil: state ? new Date(state.validUntil * 1000).toISOString() : null, windowOpen: state ? Number(block.timestamp) >= state.validAfter && Number(block.timestamp) <= state.validUntil : false, remainingUserOperations: remaining, allowanceUSDC: formatUnits(allowance, 6), healthFactor: formatEther(position[5]), repaymentConfirmed: !!state?.repayment, attackRejectedOnChain: state?.attack?.status === 'reverted' }, null, 2));
}
main().catch(error => {
  let message = error.shortMessage || error.message || 'A2 failed.';
  for (const name of ['DEV_OWNER_PRIVATE_KEY', 'SESSION_PRIVATE_KEY', 'SEPOLIA_RPC_URL', 'ZERODEV_BUNDLER_RPC', 'ZERODEV_PROJECT_ID']) {
    const value = process.env[name]; if (value) message = message.replaceAll(value, '[redacted]');
  }
  console.error(message.replace(/https?:\/\/[^\s]+/g, '[RPC URL redacted]'));
  process.exitCode = 1;
});
