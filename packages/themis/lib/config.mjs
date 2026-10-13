import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const local = fileURLToPath(new URL('../.local/', import.meta.url));
export function readEnvironment() {
  return { ...(existsSync(`${root}.env`) ? parseEnv(readFileSync(`${root}.env`, 'utf8')) : {}), ...process.env };
}
export function config() {
  const env = readEnvironment();
  const proofPath = new URL('../a1-state.json', import.meta.url);
  const account = env.KERNEL_ACCOUNT_ADDRESS || (existsSync(proofPath) ? JSON.parse(readFileSync(proofPath, 'utf8')).account : undefined);
  if (!account || !env.SEPOLIA_RPC_URL || !env.ZERODEV_BUNDLER_RPC || !env.SESSION_PRIVATE_KEY) throw new Error('Configure Kernel address, Sepolia RPC, bundler and session key.');
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const authPath = `${local}api-credentials.json`;
  if (!existsSync(authPath)) writeFileSync(authPath, JSON.stringify({ agentToken: randomBytes(32).toString('hex'), ownerToken: randomBytes(32).toString('hex') }) + '\n', { flag: 'wx', mode: 0o600 });
  const auth = JSON.parse(readFileSync(authPath, 'utf8'));
  const agentToken = env.THEMIS_AGENT_TOKEN || auth.agentToken;
  const ownerToken = env.THEMIS_OWNER_TOKEN || auth.ownerToken;
  if (agentToken.length < 32 || ownerToken.length < 32 || ownerToken === agentToken) throw new Error('Use distinct API tokens of at least 32 characters.');
  const port = Number(env.THEMIS_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid THEMIS_PORT.');
  // Deliberately do not return the development owner private key to the server.
  return { account, rpc: env.SEPOLIA_RPC_URL, bundler: env.ZERODEV_BUNDLER_RPC, sessionKey: env.SESSION_PRIVATE_KEY, agentToken, ownerToken, port, dbPath: `${local}themis.sqlite`, origins: new Set(['http://localhost:3000', 'http://127.0.0.1:3000']) };
}
