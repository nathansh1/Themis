// Local API caller: credentials stay out of shell history and process arguments.
import { readFileSync } from 'node:fs';
import { config } from './lib/config.mjs';
async function main() {
  const [method = 'GET', path = '/log', file] = process.argv.slice(2);
  if (!['GET', 'POST'].includes(method) || !/^\/(health|ruleset|intent(?:\/[A-Za-z0-9_-]+)?|log)$/.test(path)) throw new Error('Use GET or POST with a supported API path.');
  const cfg = config();
  const id = process.argv.find(arg => arg.startsWith('--idempotency-key='))?.slice('--idempotency-key='.length);
  const headers = { authorization: `Bearer ${method === 'POST' && path === '/ruleset' ? cfg.ownerToken : cfg.agentToken}` };
  let body;
  if (method === 'POST') {
    if (!file || file.startsWith('--')) throw new Error('POST requires a JSON file path.');
    body = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
    headers['content-type'] = 'application/json';
    if (id) headers['idempotency-key'] = id;
  }
  const response = await fetch(`http://127.0.0.1:${cfg.port}${path}`, { method, headers, body, signal: AbortSignal.timeout(60000) });
  console.log(JSON.stringify({ httpStatus: response.status, body: await response.json() }, null, 2));
  if (!response.ok) process.exitCode = 1;
}
main().catch(() => { console.error('API request failed. Check the local server, command arguments and JSON file.'); process.exitCode = 1; });
