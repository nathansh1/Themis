// Hand the Kernel's root authority to a Ledger address, keeping the same Kernel and Aave position.
//
// Kernel v3's ECDSA validator has no transferOwnership, and changeRootValidator to the SAME validator
// is a no-op (it skips onInstall). So the root is moved to ZeroDev's other ECDSA validator deployment
// (0.3.0), whose onInstall records the Ledger as the Kernel's owner.
//
//   node rotate-owner.mjs --ledger=0xYourLedgerAddress           dry run: checks and simulations only
//   node rotate-owner.mjs --ledger=0xYourLedgerAddress --send    submit the rotation (one way)
//
// After --send the dev key no longer controls the Kernel; admin.mjs authorize and session-a2.mjs setup
// (which sign as the dev key) stop working. Only the Ledger can authorize a ruleset from then on.
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult, decodeEventLog, concatHex, getAddress, isAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';

loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const statePath = fileURLToPath(new URL('./a1-state.json', import.meta.url));
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const kernel = getAddress(state.account);
const entryPoint = getEntryPoint('0.7');
const send = process.argv.includes('--send');

const CURRENT_VALIDATOR = '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57'; // what A1 installed (Kernel >= 3.0.1)
const NEW_VALIDATOR = '0x8104e3Ad430EA6d354d013A6789fDFc71E671c43'; // ZeroDev's 0.3.0 ECDSA validator
const NO_HOOK = '0x0000000000000000000000000000000000000001';
const rootId = validator => concatHex(['0x01', validator]);

const kernelAbi = parseAbi([
  'function changeRootValidator(bytes21 root,address hook,bytes validatorData,bytes hookData)',
  'function rootValidator() view returns (bytes21)',
]);
const validatorAbi = parseAbi(['function ecdsaValidatorStorage(address) view returns (address owner)']);

const fail = message => { console.error(`\nStopped: ${message}`); process.exit(1); };
const ledgerArg = process.argv.find(arg => arg.startsWith('--ledger='))?.split('=')[1];
if (!ledgerArg || !isAddress(ledgerArg)) fail('pass --ledger=0x... with the address shown by your Ledger.');
const ledger = getAddress(ledgerArg);
const rawKey = process.env.DEV_OWNER_PRIVATE_KEY?.trim();
if (!rawKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) fail('DEV_OWNER_PRIVATE_KEY is not set in .env.');
const devOwner = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`);
if (ledger === zeroAddress || ledger === devOwner.address) fail('the Ledger address must be a real address other than the current owner.');

const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL, { retryCount: 0, timeout: 20000 }) });
if (await client.getChainId() !== sepolia.id) fail('the RPC is not Ethereum Sepolia.');
const ownerOf = (validator, block = 'latest') => client.readContract({ address: validator, abi: validatorAbi, functionName: 'ecdsaValidatorStorage', args: [kernel], blockTag: block });
const rootNow = () => client.readContract({ address: kernel, abi: kernelAbi, functionName: 'rootValidator' });

console.log(`Kernel:        ${kernel}\nCurrent owner: ${devOwner.address}\nNew owner:     ${ledger}`);
const root = await rootNow();
if (root.toLowerCase() === rootId(NEW_VALIDATOR).toLowerCase()) {
  const owner = await ownerOf(NEW_VALIDATOR);
  console.log(`\nAlready rotated: the root validator is the 0.3.0 ECDSA validator, owner ${owner}.`);
  process.exit(owner === ledger ? 0 : 1);
}
if (root.toLowerCase() !== rootId(CURRENT_VALIDATOR).toLowerCase()) fail(`unexpected root validator ${root}.`);
if (await ownerOf(CURRENT_VALIDATOR) !== devOwner.address) fail('the dev key is not the Kernel\'s current owner on-chain.');
console.log('Checks passed: the dev key owns the Kernel and the current root validator is the one A1 installed.');

const change = encodeFunctionData({ abi: kernelAbi, functionName: 'changeRootValidator', args: [rootId(NEW_VALIDATOR), NO_HOOK, ledger, '0x'] });
const simulate = calls => client.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], validation: false }, 'latest'] }).then(result => result[0].calls);

// Simulation 1: the rotation records the Ledger as owner and makes the new validator the root.
const [changed, ownerCall, rootCall] = await simulate([
  { from: kernel, to: kernel, data: change },
  { to: NEW_VALIDATOR, data: encodeFunctionData({ abi: validatorAbi, functionName: 'ecdsaValidatorStorage', args: [kernel] }) },
  { to: kernel, data: encodeFunctionData({ abi: kernelAbi, functionName: 'rootValidator' }) },
]);
const simulatedOwner = decodeFunctionResult({ abi: validatorAbi, functionName: 'ecdsaValidatorStorage', data: ownerCall.returnData });
if (changed.status !== '0x1' || simulatedOwner !== ledger || rootCall.returnData.toLowerCase().slice(0, 44) !== rootId(NEW_VALIDATOR).toLowerCase()) fail('the rotation did not produce the expected owner and root in simulation.');
console.log('Simulation 1 OK: after the rotation, the Ledger is the owner and the new validator is the root.');

// Simulation 2: after a rotation, the new root validates a UserOperation signed through the SDK's owner
// path (an EIP-191 signature over the operation hash, exactly what a Ledger signMessage produces).
// The Ledger can't sign here, so the simulated rotation installs the dev key, which signs the test operation.
const changeToDevKey = encodeFunctionData({ abi: kernelAbi, functionName: 'changeRootValidator', args: [rootId(NEW_VALIDATOR), NO_HOOK, devOwner.address, '0x'] });
const newValidator = await signerToEcdsaValidator(client, { signer: devOwner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: NEW_VALIDATOR });
const newAccount = await createKernelAccount(client, { plugins: { sudo: newValidator }, entryPoint, kernelVersion: KERNEL_V3_3, address: kernel, index: 0n });
if (newAccount.address !== kernel) fail('the rebuilt account does not have the Kernel address.');
const fees = await client.estimateFeesPerGas();
const operation = {
  sender: kernel, nonce: await newAccount.getNonce(), callData: await newAccount.encodeCalls([{ to: devOwner.address, value: 0n, data: '0x' }]),
  callGasLimit: 100000n, verificationGasLimit: 500000n, preVerificationGas: 100000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
};
operation.signature = await newAccount.signUserOperation(operation);
const [, handled] = await simulate([
  { from: kernel, to: kernel, data: changeToDevKey },
  { from: devOwner.address, to: entryPoint.address, data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[toPackedUserOperation(operation)], devOwner.address] }), gas: '0x2dc6c0' },
]);
const events = (handled.logs || []).map(log => { try { return decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics }); } catch { return null; } });
const outcome = events.find(event => event?.eventName === 'UserOperationEvent');
if (handled.status !== '0x1' || !outcome || !outcome.args.success) fail(`the new root validator did not accept a signed UserOperation in simulation (status ${handled.status}, ${handled.error?.message || 'no UserOperationEvent'}). Nothing was sent.`);
console.log('Simulation 2 OK: after the rotation, an owner-signed UserOperation passes validation and executes.');

if (!send) { console.log('\nDry run complete; nothing was sent. Confirm the address above matches your Ledger screen, then re-run with --send.'); process.exit(0); }

// Submit as the current owner (the dev key signs this one last operation).
const currentValidator = await signerToEcdsaValidator(client, { signer: devOwner, entryPoint, kernelVersion: KERNEL_V3_3 });
const currentAccount = await createKernelAccount(client, { plugins: { sudo: currentValidator }, entryPoint, kernelVersion: KERNEL_V3_3, index: 0n });
if (currentAccount.address !== kernel) fail('the current owner path does not derive the Kernel address.');
const kernelClient = createKernelAccountClient({ account: currentAccount, client, chain: sepolia, bundlerTransport: http(process.env.ZERODEV_BUNDLER_RPC, { retryCount: 0, timeout: 30000 }) });
const hash = await kernelClient.sendUserOperation({ calls: [{ to: kernel, value: 0n, data: change }] });
console.log(`UserOperation submitted: ${hash}`);
state.ownerRotation = { status: 'pending', userOpHash: hash, from: devOwner.address, to: ledger, validator: NEW_VALIDATOR };
writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const receipt = await kernelClient.waitForUserOperationReceipt({ hash, timeout: 120000 });
if (!receipt.success) fail('the rotation UserOperation reverted; the owner is unchanged. Check the state file before retrying.');
const [finalOwner, finalRoot] = [await ownerOf(NEW_VALIDATOR), await rootNow()];
if (finalOwner !== ledger || finalRoot.toLowerCase() !== rootId(NEW_VALIDATOR).toLowerCase()) fail('rotation mined but on-chain state is not as expected. Inspect before doing anything else.');
Object.assign(state.ownerRotation, { status: 'done', txHash: receipt.receipt.transactionHash });
state.owner = ledger; state.rootValidator = NEW_VALIDATOR;
writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
console.log(`\nDone. The Ledger (${ledger}) now owns the Kernel; root validator ${NEW_VALIDATOR}.\nTransaction: https://sepolia.etherscan.io/tx/${receipt.receipt.transactionHash}`);
