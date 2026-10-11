import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseUnits, formatEther, formatUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { getEntryPoint, KERNEL_V3_3 } from '@zerodev/sdk/constants';

// Fixed Sepolia deployment addresses avoid accidentally mixing testnet markets.
loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const pool = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
const provider = '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31';
const oracle = '0x2da88497588bf89281816106C7259e31AF45a663';
const weth = '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c';
const usdc = '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8';
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
]);
const poolAbi = parseAbi([
  'function getConfiguration(address asset) view returns ((uint256 data))',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)',
  'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)',
  'function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)',
]);
const dataAbi = parseAbi(['function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)']);
const oracleAbi = parseAbi(['function getAssetPrice(address asset) view returns (uint256)', 'function BASE_CURRENCY_UNIT() view returns (uint256)']);
const statePath = fileURLToPath(new URL('./a1-state.json', import.meta.url));
const send = process.argv.includes('--send');
const supplyTarget = parseEther('0.01');
const gasTarget = parseEther('0.005');
const usdcTarget = parseUnits('100', 6);

async function main() {
  const rawKey = process.env.DEV_OWNER_PRIVATE_KEY?.trim();
  if (!rawKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error('Set a valid development private key locally in .env.');
  if (!process.env.SEPOLIA_RPC_URL || !process.env.ZERODEV_BUNDLER_RPC) throw new Error('SEPOLIA_RPC_URL and ZERODEV_BUNDLER_RPC are required.');
  const owner = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`);
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL, { retryCount: 0, timeout: 20000 }) });
  if (await client.getChainId() !== sepolia.id) throw new Error('RPC must be Ethereum Sepolia.');
  const entryPoint = getEntryPoint('0.7');
  const validator = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  // The same owner, version and index derive the same address on every run.
  const account = await createKernelAccount(client, { plugins: { sudo: validator }, entryPoint, kernelVersion: KERNEL_V3_3, index: 0n });
  const kernel = createKernelAccountClient({ account, chain: sepolia, client, bundlerTransport: http(process.env.ZERODEV_BUNDLER_RPC, { retryCount: 0, timeout: 30000 }) });
  const ownerWallet = createWalletClient({ account: owner, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL, { retryCount: 0 }) });
  console.log(`Owner: ${owner.address}\nKernel: ${account.address}\nKernel version: ${KERNEL_V3_3}; EntryPoint: ${entryPoint.address}`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { transactions: [] };
  if (state.account && state.account.toLowerCase() !== account.address.toLowerCase()) throw new Error('Saved account differs from derived account; refusing to overwrite proof.');
  if (send && state.transactions.some(transaction => transaction.status === 'pending')) throw new Error('A saved transaction is still pending. Verify its receipt before resuming to avoid duplicate submissions.');
  Object.assign(state, { chainId: sepolia.id, owner: owner.address, account: account.address, kernelVersion: KERNEL_V3_3, entryPoint: entryPoint.address, pool, weth, usdc });
  const save = () => writeFileSync(statePath, JSON.stringify(state, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  const balance = (token, address) => client.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [address] });
  const position = () => client.readContract({ address: pool, abi: poolAbi, functionName: 'getUserAccountData', args: [account.address] });
  const [wethConfig, usdcConfig, wethTokens, usdcTokens, wethPrice, usdcPrice, baseUnit, wethDecimals, usdcDecimals, entryPoints] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'getConfiguration', args: [weth] }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'getConfiguration', args: [usdc] }),
    client.readContract({ address: provider, abi: dataAbi, functionName: 'getReserveTokensAddresses', args: [weth] }),
    client.readContract({ address: provider, abi: dataAbi, functionName: 'getReserveTokensAddresses', args: [usdc] }),
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [weth] }),
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [usdc] }),
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT' }),
    client.readContract({ address: weth, abi: erc20, functionName: 'decimals' }),
    client.readContract({ address: usdc, abi: erc20, functionName: 'decimals' }),
    kernel.request({ method: 'eth_supportedEntryPoints', params: [] }),
  ]);
  if (!entryPoints.some(address => address.toLowerCase() === entryPoint.address.toLowerCase())) throw new Error('Bundler does not support the selected EntryPoint.');
  if (wethDecimals !== 18 || usdcDecimals !== 6 || wethPrice === 0n || usdcPrice === 0n) throw new Error('Unexpected token decimals or zero oracle price.');
  // Aave packs reserve flags and collateral parameters into a uint256 bitmap.
  for (const [name, config] of [['WETH', wethConfig.data], ['USDC', usdcConfig.data]]) {
    const active = !!(config & (1n << 56n));
    const frozen = !!(config & (1n << 57n));
    const paused = !!(config & (1n << 60n));
    console.log(`${name}: active=${active}, frozen=${frozen}, paused=${paused}`);
    if (!active || frozen || paused) throw new Error(`${name} reserve cannot be used for this setup.`);
  }
  if (!(usdcConfig.data & (1n << 58n)) || !(wethConfig.data & 65535n)) throw new Error('USDC borrowing or WETH collateral is disabled.');
  console.log(`Oracle prices in base units: WETH=${wethPrice}, USDC=${usdcPrice}; base unit=${baseUnit}`);
  const [ownerEth, ownerWeth, ownerUsdc, kernelEth, kernelWeth, kernelUsdc, supplied] = await Promise.all([
    client.getBalance({ address: owner.address }), balance(weth, owner.address), balance(usdc, owner.address),
    client.getBalance({ address: account.address }), balance(weth, account.address), balance(usdc, account.address), balance(wethTokens[0], account.address),
  ]);
  const wethNeeded = supplied >= supplyTarget ? 0n : supplyTarget - supplied;
  const wethTransfer = wethNeeded > kernelWeth ? wethNeeded - kernelWeth : 0n;
  const usdcTransfer = kernelUsdc < usdcTarget ? usdcTarget - kernelUsdc : 0n;
  const ethTransfer = kernelEth < gasTarget ? gasTarget - kernelEth : 0n;
  console.log(`Funding needed: ${formatEther(ethTransfer)} ETH, ${formatEther(wethTransfer)} WETH, ${formatUnits(usdcTransfer, 6)} USDC`);
  if (ownerEth < ethTransfer + parseEther('0.005') || ownerWeth < wethTransfer || ownerUsdc < usdcTransfer) throw new Error('Development wallet lacks the required funding plus gas reserve.');
  const dataBefore = await position();
  console.log(`Existing collateral=${dataBefore[0]}, debt=${dataBefore[1]}`);
  save();
  if (!send) { console.log('Preflight passed. No transactions sent. Run with --send to fund Kernel and open the position.'); return; }

  async function ownerTransaction(label, request) {
    const hash = await ownerWallet.sendTransaction(request);
    state.transactions.push({ label, txHash: hash, status: 'pending' }); save();
    console.log(`${label}: https://sepolia.etherscan.io/tx/${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
    state.transactions.at(-1).status = receipt.status; save();
    if (receipt.status !== 'success') throw new Error(`${label} reverted.`);
  }
  if (ethTransfer) await ownerTransaction('Fund Kernel gas', { to: account.address, value: ethTransfer });
  for (const [name, token, amount] of [['WETH', weth, wethTransfer], ['USDC', usdc, usdcTransfer]]) {
    if (!amount) continue;
    await client.simulateContract({ account: owner, address: token, abi: erc20, functionName: 'transfer', args: [account.address, amount] });
    await ownerTransaction(`Fund Kernel ${name}`, { to: token, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [account.address, amount] }) });
  }
  async function kernelTransaction(label, calls) {
    // Bundler preparation estimates gas and validates the complete UserOperation.
    const operation = await kernel.prepareUserOperation({ calls });
    // Preparation inserts a dummy signature for gas estimation. Omit it so
    // sendUserOperation obtains the actual owner signature before submission.
    const { signature: _stubSignature, ...unsignedOperation } = operation;
    const hash = await kernel.sendUserOperation(unsignedOperation);
    state.transactions.push({ label, userOpHash: hash, status: 'pending' }); save();
    console.log(`${label} UserOperation: ${hash}`);
    const receipt = await kernel.waitForUserOperationReceipt({ hash, timeout: 120000 });
    Object.assign(state.transactions.at(-1), { txHash: receipt.receipt.transactionHash, status: receipt.success ? 'success' : 'reverted' }); save();
    console.log(`${label}: https://sepolia.etherscan.io/tx/${receipt.receipt.transactionHash}`);
    if (!receipt.success) throw new Error(`${label} reverted.`);
  }
  if (wethNeeded) await kernelTransaction('Approve and supply WETH', [
    { to: weth, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [pool, wethNeeded] }), value: 0n },
    { to: pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'supply', args: [weth, wethNeeded, account.address, 0] }), value: 0n },
  ]);
  const afterSupply = await position();
  // Borrow at most one quarter of the available capacity, capped at 5 USDC.
  // Existing debt means setup already borrowed; do not borrow again on reruns.
  if (afterSupply[1] === 0n) {
    const capacityAmount = afterSupply[2] * 10n ** 6n / usdcPrice / 4n;
    const borrowAmount = capacityAmount < parseUnits('5', 6) ? capacityAmount : parseUnits('5', 6);
    if (borrowAmount < parseUnits('0.01', 6)) throw new Error('Insufficient borrowing capacity for a useful test position.');
    if (await balance(usdc, usdcTokens[0]) < borrowAmount) throw new Error('Aave has insufficient USDC liquidity.');
    console.log(`Borrowing ${formatUnits(borrowAmount, 6)} USDC at variable rate.`);
    await kernelTransaction('Borrow USDC', [{ to: pool, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: 'borrow', args: [usdc, borrowAmount, 2n, 0, account.address] }) }]);
  }
  const data = await position();
  if (data[0] === 0n || data[1] === 0n || data[5] <= parseEther('1')) throw new Error('Position did not meet A1 success criteria.');
  const code = await client.getCode({ address: account.address });
  if (!code || code === '0x') throw new Error('Kernel deployment was not confirmed.');
  state.position = { collateralBase: data[0], debtBase: data[1], availableBorrowsBase: data[2], baseCurrencyUnit: baseUnit, healthFactor: formatEther(data[5]), observedAt: new Date().toISOString() };
  save();
  console.log(`A1 complete. Health factor: ${state.position.healthFactor}\nProof saved to ${statePath}`);
}

main().catch(error => {
  let message = error.shortMessage || error.message || 'Aave setup failed.';
  for (const name of ['DEV_OWNER_PRIVATE_KEY', 'SEPOLIA_RPC_URL', 'ZERODEV_BUNDLER_RPC', 'ZERODEV_PROJECT_ID']) {
    const value = process.env[name];
    if (value) message = message.replaceAll(value, '[redacted]');
  }
  console.error(message.replace(/https?:\/\/[^\s]+/g, '[RPC URL redacted]'));
  process.exitCode = 1;
});
