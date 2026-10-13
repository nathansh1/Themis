import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { config, local } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { createChainBackend } from './lib/session.mjs';
import { Service } from './lib/service.mjs';
import { httpServer } from './lib/http.mjs';

async function main() {
  const cfg = config();
  delete process.env.DEV_OWNER_PRIVATE_KEY;
  const lock = `${local}server.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid server lock; inspect it before restarting.');
    try { process.kill(pid, 0); throw new Error('A Themis server already holds the database lock.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const unlock = () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); };
  process.once('exit', unlock);
  const store = new Store(cfg.dbPath);
  const backend = createChainBackend(cfg);
  await backend.assertChain();
  const service = new Service({ store, backend, account: cfg.account });
  service.recoverPreparation(); await service.reconcile();
  const server = httpServer(service, cfg);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('error', () => { console.error('Unable to bind the local API port.'); process.exit(1); });
  server.listen(cfg.port, '127.0.0.1', () => console.log(`Themis listening at http://127.0.0.1:${cfg.port}; API credentials are in packages/themis/.local/api-credentials.json`));
  const timer = setInterval(() => service.serial(() => service.reconcile()).catch(() => {}), 3000);
  timer.unref();
  const shutdown = () => { clearInterval(timer); server.close(() => service.tail.finally(() => { store.close(); unlock(); process.exit(0); })); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch(() => { console.error('Themis startup failed; check configuration, the server lock and Sepolia connectivity. Credentials omitted.'); process.exitCode = 1; });
