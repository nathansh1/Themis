import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const send = process.argv.includes('--send');
const recipientArg = process.argv.find(arg => arg.startsWith('--recipient='))?.split('=')[1];
const tokenArg = process.argv.find(arg => arg.startsWith('--token='))?.split('=')[1];
const faucet = '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D';
const tokens = [
  { symbol: 'WETH', address: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c', amount: '1', decimals: 18 },
  { symbol: 'USDC', address: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8', amount: '100', decimals: 6 },
];
const abi = parseAbi([
  'function isPermissioned() view returns (bool)',
  'function isMintable(address) view returns (bool)',
  'function MAX_MINT_AMOUNT() view returns (uint256)',
  'function mint(address token, address to, uint256 amount) returns (uint256)',
]);
const erc20 = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
]);

async function main() {
  if (tokenArg && !tokens.some(token => token.symbol === tokenArg)) throw new Error('Use --token=USDC or --token=WETH.');
  if (!process.env.SEPOLIA_RPC_URL) throw new Error('SEPOLIA_RPC_URL is missing.');
  const rawKey = process.env.DEV_OWNER_PRIVATE_KEY?.trim();
  // Wallet exports may omit 0x; viem requires it. Normalize only in memory.
  if (rawKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error('DEV_OWNER_PRIVATE_KEY must contain 64 hexadecimal characters, optionally prefixed with 0x.');
  const key = rawKey ? (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) : undefined;
  const account = key ? privateKeyToAccount(key) : undefined;
  const recipient = recipientArg || account?.address;
  if (recipient && !isAddress(recipient)) throw new Error('Invalid recipient address.');
  if (send && !account) throw new Error('Set DEV_OWNER_PRIVATE_KEY locally in .env before using --send.');
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL, { retryCount: 0, timeout: 20000 }) });
  const chainId = await client.getChainId();
  if (chainId !== sepolia.id) throw new Error(`RPC returned chain ID ${chainId}; expected Ethereum Sepolia (${sepolia.id}).`);
  const [permissioned, maximum] = await Promise.all([
    client.readContract({ address: faucet, abi, functionName: 'isPermissioned' }),
    client.readContract({ address: faucet, abi, functionName: 'MAX_MINT_AMOUNT' }),
  ]);
  console.log(`Faucet: ${faucet}; permissioned: ${permissioned}; maximum per request: ${maximum} tokens`);
  if (permissioned) throw new Error('Faucet requires owner permission.');
  const prepared = [];
  const blocked = [];
  for (const token of tokens.filter(token => !tokenArg || token.symbol === tokenArg)) {
    const [mintable, decimals] = await Promise.all([
      client.readContract({ address: faucet, abi, functionName: 'isMintable', args: [token.address] }),
      client.readContract({ address: token.address, abi: erc20, functionName: 'decimals' }),
    ]);
    console.log(`${token.symbol}: mintable=${mintable}, decimals=${decimals}`);
    if (!mintable || decimals !== token.decimals) {
      blocked.push(token.symbol);
      continue;
    }
    if (BigInt(token.amount) > maximum) throw new Error(`${token.symbol} request exceeds faucet limit.`);
    if (recipient) {
      const balance = await client.readContract({ address: token.address, abi: erc20, functionName: 'balanceOf', args: [recipient] });
      console.log(`${token.symbol} balance before: ${formatUnits(balance, decimals)}`);
      const { request } = await client.simulateContract({
        account: account || recipient, address: faucet, abi, functionName: 'mint',
        args: [token.address, recipient, parseUnits(token.amount, decimals)],
      });
      prepared.push({ token, request });
      console.log(`Simulation passed: mint ${token.amount} ${token.symbol} to ${recipient}`);
    }
  }
  if (blocked.length) throw new Error(`Token checks failed for ${blocked.join(', ')}; no transactions sent.`);
  if (!recipient) {
    console.log('Faucet checks complete. Provide --recipient=0x... or set DEV_OWNER_PRIVATE_KEY locally to simulate minting.');
    return;
  }
  const gasBalance = await client.getBalance({ address: account?.address || recipient });
  console.log(`Signer ETH balance: ${formatUnits(gasBalance, 18)}`);
  if (!send) { console.log('Simulation only; no transactions sent. Use --send to submit.'); return; }
  if (gasBalance === 0n) throw new Error('Signer has no Sepolia ETH for gas.');
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL, { retryCount: 0 }) });
  for (const { token, request } of prepared) {
    const hash = await wallet.writeContract(request);
    console.log(`${token.symbol} transaction: https://sepolia.etherscan.io/tx/${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`${token.symbol} transaction reverted.`);
    const balance = await client.readContract({ address: token.address, abi: erc20, functionName: 'balanceOf', args: [recipient] });
    console.log(`${token.symbol} confirmed; balance after: ${formatUnits(balance, token.decimals)}`);
  }
}

main().catch(error => {
  // RPC errors can contain credential-bearing URLs; never print their full objects.
  let message = error.shortMessage || error.message || 'Faucet request failed.';
  for (const secret of [process.env.SEPOLIA_RPC_URL, process.env.DEV_OWNER_PRIVATE_KEY]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  console.error(message.replace(/https?:\/\/[^\s]+/g, '[RPC URL redacted]'));
  process.exitCode = 1;
});
