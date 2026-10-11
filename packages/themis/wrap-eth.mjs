import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const weth = '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c';
const abi = parseAbi([
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
]);

async function main() {
  const amount = process.argv.find(arg => arg.startsWith('--amount='))?.split('=')[1];
  const send = process.argv.includes('--send');
  if (!amount || !/^\d+(\.\d{1,18})?$/.test(amount)) throw new Error('Provide an ETH amount, such as --amount=0.01.');
  const value = parseEther(amount);
  if (value <= 0n) throw new Error('Amount must be greater than zero.');
  const rawKey = process.env.DEV_OWNER_PRIVATE_KEY?.trim();
  if (!rawKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error('Set a valid DEV_OWNER_PRIVATE_KEY locally in .env.');
  if (!process.env.SEPOLIA_RPC_URL) throw new Error('SEPOLIA_RPC_URL is missing.');
  const account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`);
  const transport = http(process.env.SEPOLIA_RPC_URL, { retryCount: 0, timeout: 20000 });
  const client = createPublicClient({ chain: sepolia, transport });
  if (await client.getChainId() !== sepolia.id) throw new Error('RPC must point to Ethereum Sepolia.');

  const [ethBefore, wethBefore] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({ address: weth, abi, functionName: 'balanceOf', args: [account.address] }),
  ]);
  console.log(`Wallet: ${account.address}; ETH: ${formatEther(ethBefore)}; WETH: ${formatEther(wethBefore)}`);
  // Retain test ETH for later account setup. This is a balance reserve, not a fee estimate.
  if (ethBefore < value + parseEther('0.01')) throw new Error('Wrapping would leave less than 0.01 ETH reserved for gas.');
  const { request } = await client.simulateContract({ account, address: weth, abi, functionName: 'deposit', value });
  const gas = await client.estimateContractGas({ account, address: weth, abi, functionName: 'deposit', value });
  const fees = await client.estimateFeesPerGas();
  const gasBudget = gas * 2n;
  if (ethBefore < value + gasBudget * fees.maxFeePerGas + parseEther('0.01')) throw new Error('Insufficient ETH to wrap, cover estimated gas, and preserve the gas reserve.');
  console.log(`Simulation passed: wrap ${amount} Sepolia ETH into WETH.`);
  if (!send) { console.log('Simulation only; use --send to submit.'); return; }
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const hash = await wallet.writeContract({ ...request, gas: gasBudget, ...fees });
  console.log(`Transaction: https://sepolia.etherscan.io/tx/${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
  if (receipt.status !== 'success') throw new Error('Wrap transaction reverted.');
  const balance = await client.readContract({ address: weth, abi, functionName: 'balanceOf', args: [account.address] });
  console.log(`Confirmed WETH balance: ${formatEther(balance)}`);
}

main().catch(error => {
  // Provider errors can include private RPC URLs; report only a redacted summary.
  let message = error.shortMessage || error.message || 'Wrapping failed.';
  for (const secret of [process.env.SEPOLIA_RPC_URL, process.env.DEV_OWNER_PRIVATE_KEY]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  console.error(message.replace(/https?:\/\/[^\s]+/g, '[RPC URL redacted]'));
  process.exitCode = 1;
});
