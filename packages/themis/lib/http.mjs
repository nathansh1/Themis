import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { publicGrant, result } from './service.mjs';
function equals(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('json_required'), { status: 415 });
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 16384) throw Object.assign(new Error('body_too_large'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}
export function httpServer(service, cfg) {
  return createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    try {
      const origin = req.headers.origin;
      if (origin && !cfg.origins.has(origin)) return reply(403, { error: 'origin_not_allowed' });
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
        return reply(200, {});
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, { status: 'ok', chainId: 11155111 });
      const authorization = req.headers.authorization || '';
      const isOwner = equals(authorization, `Bearer ${cfg.ownerToken}`);
      const isAgent = equals(authorization, `Bearer ${cfg.agentToken}`);
      if (!isOwner && !isAgent) return reply(401, { error: 'unauthorized' });
      if (req.method === 'POST' && url.pathname === '/ruleset') {
        // Proposals are inert: either token may propose, and only an owner authorization activates one.
        const response = service.ruleset(await jsonBody(req));
        return reply(response.code, response.body);
      }
      const owned = url.pathname.match(/^\/ruleset\/([0-9a-f]{64})\/(prepare|authorize)$/);
      if (req.method === 'POST' && owned) {
        if (!isOwner) return reply(403, { error: 'owner_required' });
        const body = owned[2] === 'authorize' ? await jsonBody(req) : null;
        const response = owned[2] === 'prepare' ? await service.prepareOwner(owned[1]) : await service.authorize(owned[1], body?.signatures);
        return reply(response.code, response.body);
      }
      if (req.method === 'POST' && url.pathname === '/intent') {
        const response = await service.intent(req.headers['idempotency-key'], await jsonBody(req));
        return reply(response.code, response.body);
      }
      if (req.method === 'GET' && url.pathname === '/rulesets') return reply(200, service.rulesets());
      if (req.method === 'GET' && url.pathname === '/ruleset') return reply(200, publicGrant(service.store.active()));
      if (req.method === 'GET' && url.pathname === '/log') {
        const limit = Number(url.searchParams.get('limit') || 100);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) return reply(400, { error: 'invalid_limit' });
        return reply(200, { entries: service.store.log(limit).filter(row => !row.internal).map(({ fingerprint: _fingerprint, ...row }) => row) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/intent/')) {
        const row = service.store.request(decodeURIComponent(url.pathname.slice('/intent/'.length)));
        return row && !row.internal ? reply(row.status === 'pending' ? 202 : 200, result(row)) : reply(404, { error: 'not_found' });
      }
      reply(404, { error: 'not_found' });
    } catch (error) {
      const known = [400, 413, 415].includes(error.status);
      reply(known ? error.status : 500, { error: known ? error.message : 'internal_error' });
    }
  });
}
