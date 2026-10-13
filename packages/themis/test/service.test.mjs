import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { Service } from '../lib/service.mjs';
import { httpServer } from '../lib/http.mjs';
import { units, buildPolicies, repayCall, poolAbi, usdc, pool } from '../lib/session.mjs';
import { decodeFunctionData } from 'viem';
import { MissingSignature } from '../lib/owner.mjs';

const account = '0x36DeFE9447BfF3855338FbBE5E376F6460f0E23b';
const rules = { account, chainId: 11155111, window: { start: 100, end: 1000 }, trigger: { healthFactorBelow: 1.15 }, allow: [{ protocol: 'aave-v3', action: 'repay', asset: 'USDC' }], maxPerAction: '1', maxActions: 3 };
const intent = { action: 'repay', asset: 'USDC', amount: '1', reason: 'test' };
const hash = `0x${'ab'.repeat(32)}`;
const digestA = `0x${'1'.repeat(64)}`, digestB = `0x${'2'.repeat(64)}`, sig = `0x${'a'.repeat(130)}`;
const next = { ...rules, window: { start: 1500, end: 5000 } };
function fixture(t, options = {}) {
  const store = new Store(options.path || ':memory:');
  if (!store.active()) store.activate({ id: 'grant', status: 'active', rules, initialSpent: '0' });
  const backend = {
    sends: 0, prepares: 0, found: true,
    now: async () => 2000,
    prepareAuthorization: async () => ({ operation: { sender: account, nonce: 5n, callData: '0x' }, hash, requests: [{ id: digestA, kind: 'typedData', typedData: {} }, { id: digestB, kind: 'message', raw: hash }], amount: 3000000n, owner: account, sessionKey: account }),
    finalizeAuthorization: async () => ({ operation: { sender: account }, hash, serialized: 'serialized-permission', permissionId: `0x${'12'.repeat(4)}`, ratePolicy: account }),
    snapshot: async () => ({ now: 200, allowance: 3000000n, remaining: 3, balance: 100000000n, debt: 500000000n }),
    prepare: async () => { backend.prepares++; return { hash }; },
    broadcast: async () => { backend.sends++; },
    receipt: async () => backend.found ? { success: true, receipt: { transactionHash: hash } } : null,
    ...options.backend,
  };
  const service = new Service({ store, backend, account });
  t.after(() => store.close());
  return { store, backend, service };
}
test('exact decimal conversion and fixed repayment target', () => {
  assert.equal(units('0.000001'), 1n);
  for (const value of ['1e3', '-1', '0.0000001', '1 ', '01', 1]) assert.throws(() => units(value));
  const call = repayCall(account, units('1'));
  assert.equal(call.to, pool); assert.equal(call.value, 0n);
  assert.deepEqual(decodeFunctionData({ abi: poolAbi, data: call.data }).args, [usdc, 1000000n, 2n, account]);
});
test('concurrent duplicates send once and changed payload conflicts', async t => {
  const { service, backend } = fixture(t);
  const replies = await Promise.all(Array.from({ length: 5 }, () => service.intent('request-1', intent)));
  assert.ok(replies.every(reply => reply.body.status === 'executed'));
  assert.equal(backend.sends, 1); assert.equal(backend.prepares, 1);
  assert.equal((await service.intent('request-1', { ...intent, amount: '0.5' })).code, 409);
});
test('unknown network outcome stays pending and blocks another nonce', async t => {
  const { service, backend } = fixture(t, { backend: { found: false } });
  backend.broadcast = async () => { backend.sends++; throw new Error('timeout after submission'); };
  assert.equal((await service.intent('request-1', intent)).body.status, 'pending');
  assert.equal((await service.intent('request-1', intent)).body.status, 'pending');
  assert.deepEqual((await service.intent('request-2', intent)).body.failed, ['account_busy']);
  assert.equal(backend.sends, 1);
  backend.found = true; await service.reconcile();
  assert.equal((await service.intent('request-1', intent)).body.status, 'executed');
});
test('operation hash is durable before the first network submission', async t => {
  const { service, store, backend } = fixture(t);
  backend.broadcast = async prepared => {
    const saved = store.request('request-1');
    assert.equal(saved.status, 'pending'); assert.equal(saved.userOpHash, prepared.hash);
  };
  assert.equal((await service.intent('request-1', intent)).body.status, 'executed');
});
test('database in-flight constraint protects separate service instances', async t => {
  const { service, store, backend } = fixture(t);
  const second = new Service({ store, backend, account });
  let release;
  backend.snapshot = () => new Promise(resolve => { release = () => resolve({ now: 200, allowance: 3000000n, remaining: 3, balance: 100000000n, debt: 1n }); });
  const firstRequest = service.intent('request-1', intent);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await second.intent('request-2', intent)).body.failed, ['account_busy']);
  backend.snapshot = async () => ({ now: 200, allowance: 3000000n, remaining: 3, balance: 100000000n, debt: 1n });
  release(); await firstRequest; assert.equal(backend.sends, 1);
});
test('restart fails unfinished preparation without treating it as submitted', t => {
  const { service, store } = fixture(t);
  store.insert({ id: 'request-1', fingerprint: 'unfinished', status: 'checking' });
  service.recoverPreparation();
  assert.equal(store.pending().length, 0);
  assert.deepEqual(store.request('request-1').failed, ['interrupted_before_submission']);
});
test('simulation or RPC failures cannot reach broadcast', async t => {
  const { service, backend } = fixture(t);
  backend.prepare = async () => { throw new Error('call reverted'); };
  assert.deepEqual((await service.intent('request-1', intent)).body.failed, ['simulation_failed']);
  backend.snapshot = async () => { throw new Error('provider down'); };
  assert.equal((await service.intent('request-2', intent)).code, 503);
  assert.equal(backend.sends, 0);
});
test('persistent pending request reconciles after process replacement without resend', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'themis-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const first = new Store(path);
  first.activate({ id: 'grant', status: 'active', rules, initialSpent: '0' });
  const offline = { snapshot: async () => ({ now: 200, allowance: 3000000n, remaining: 3, balance: 100000000n, debt: 1n }), prepare: async () => ({ hash }), broadcast: async () => {}, receipt: async () => null };
  await new Service({ store: first, backend: offline, account }).intent('request-1', intent);
  first.close();
  const second = new Store(path);
  try {
    const backend = { ...offline, broadcast: async () => assert.fail('must not broadcast on recovery'), receipt: async () => ({ success: true, receipt: { transactionHash: hash } }) };
    const service = new Service({ store: second, backend, account });
    service.recoverPreparation(); await service.reconcile();
    assert.equal((await service.intent('request-1', intent)).body.status, 'executed');
    assert.equal(second.log().length, 1);
  } finally { second.close(); }
});
test('transfer, unknown calldata and imprecise amounts never reach signing', async t => {
  const { service, backend } = fixture(t);
  for (const [i, value] of [{ ...intent, action: 'transfer' }, { ...intent, calldata: '0xaabb' }, { ...intent, amount: '0.0000001' }, null].entries()) assert.equal((await service.intent(`request-${i}`, value)).body.status, 'rejected');
  assert.equal(backend.prepares, 0);
});
test('expiry is checked again after slow simulation', async t => {
  let now = 200;
  const { service, backend } = fixture(t);
  backend.snapshot = async () => ({ now, allowance: 3000000n, remaining: 3, balance: 100000000n, debt: 1n });
  backend.prepare = async () => { now = 1000; return { hash }; };
  assert.ok((await service.intent('request-1', intent)).body.failed.includes('window_closed'));
  assert.equal(backend.sends, 0);
});
test('running total includes activity before A3 and chain allowance independently constrains it', async t => {
  const { store, service, backend } = fixture(t);
  store.activate({ ...store.active(), initialSpent: '2000000' });
  assert.equal((await service.intent('request-1', intent)).body.status, 'executed');
  assert.ok((await service.intent('request-2', intent)).body.failed.includes('over_total_limit'));
  backend.snapshot = async () => ({ now: 200, allowance: 0n, remaining: 0, balance: 100000000n, debt: 1n });
  const failed = (await service.intent('request-3', intent)).body.failed;
  assert.ok(failed.includes('action_count_exhausted')); assert.ok(failed.includes('insufficient_allowance'));
});
test('reverted receipt is not reported as executed and releases pending slot', async t => {
  const { service, store } = fixture(t, { backend: { receipt: async () => ({ success: false, receipt: { transactionHash: hash } }) } });
  assert.deepEqual((await service.intent('request-1', intent)).body.failed, ['execution_reverted']);
  assert.equal(store.pending().length, 0);
});
test('ruleset proposals compile fixed policies without activation', t => {
  const { service, store } = fixture(t);
  const proposal = service.ruleset({ ...rules, maxPerAction: '0.5' });
  assert.equal(proposal.body.status, 'awaiting_owner'); assert.equal(store.active().id, 'grant');
  assert.equal(proposal.body.policyPreview.length, 3);
  assert.equal(service.ruleset({ ...rules, account: '0x0000000000000000000000000000000000000001' }).code, 400);
  assert.equal(service.ruleset({ ...rules, maxActions: 100 }).code, 400);
  const policies = buildPolicies(rules);
  assert.equal(policies[0].policyParams.permissions[0].target, pool);
});
test('HTTP separates owner and agent, rejects bad origins and logs decisions', async t => {
  const { service } = fixture(t);
  const cfg = { agentToken: 'a'.repeat(64), ownerToken: 'b'.repeat(64), origins: new Set(['http://localhost:3000']) };
  const server = httpServer(service, cfg);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${cfg.agentToken}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${url}/log`)).status, 401);
  assert.equal((await fetch(`${url}/ruleset`, { method: 'POST', body: JSON.stringify(rules) })).status, 401);
  assert.equal((await fetch(`${url}/log`, { headers: { ...headers, origin: 'https://attacker.example' } })).status, 403);
  const response = await fetch(`${url}/intent`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'http-request' }, body: JSON.stringify({ ...intent, action: 'transfer' }) });
  assert.ok((await response.json()).failed.includes('action_not_allowed'));
  const log = await (await fetch(`${url}/log`, { headers })).json(); assert.equal(log.entries.length, 1);
  const proposal = await fetch(`${url}/ruleset`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${cfg.ownerToken}` }, body: JSON.stringify(rules) });
  assert.equal(proposal.status, 202); assert.equal((await proposal.json()).serialized, undefined);
  // The agent token may propose, but a proposal stays pending: nothing becomes active without owner authorization.
  const proposed = await fetch(`${url}/ruleset`, { method: 'POST', headers, body: JSON.stringify({ ...rules, window: { start: Math.floor(Date.now() / 1000), end: Math.floor(Date.now() / 1000) + 3600 }, maxActions: rules.maxActions - 1 }) });
  const body = await proposed.json();
  assert.equal(proposed.status, 202); assert.equal(body.status, 'awaiting_owner'); assert.equal(body.serialized, undefined);
  assert.equal((await (await fetch(`${url}/ruleset`, { headers })).json()).id, 'grant'); // the fixture's active grant is untouched
  const listed = await (await fetch(`${url}/rulesets`, { headers })).json();
  assert.equal(listed.filter(item => item.status === 'active').length, 1);
  assert.ok(listed.some(item => item.id === body.id && item.status === 'awaiting_owner'));
  assert.ok(listed.some(item => item.status === 'expired')); // the earlier proposal's window (ending at t=1000) is over
  assert.ok(listed.every(item => item.serialized === undefined));
});

test('owner authorization: prepare, then signatures activate the ruleset only after the approval lands', async t => {
  const { service, store, backend } = fixture(t);
  const grant = service.ruleset(next).body;
  const prepared = await service.prepareOwner(grant.id);
  assert.equal(prepared.code, 200);
  assert.deepEqual(prepared.body.requests.map(request => request.id), [digestA, digestB]);
  assert.equal(prepared.body.allowanceUnits, '3000000'); assert.equal(prepared.body.owner, account);
  assert.equal(store.grant(grant.id).status, 'awaiting_owner');
  assert.equal((await service.authorize(grant.id, { [digestA]: sig })).body.failed[0], 'missing_signature');
  assert.equal((await service.authorize(grant.id, { [digestA]: sig, nope: sig })).body.failed[0], 'invalid_signatures');
  let hashAtBroadcast;
  backend.broadcast = async () => { backend.sends++; hashAtBroadcast = store.request(`owner-${grant.id}`).userOpHash; };
  backend.found = false;
  const sent = await service.authorize(grant.id, { [digestA]: sig, [digestB]: sig });
  assert.equal(sent.code, 202); assert.equal(sent.body.status, 'authorizing');
  assert.equal(hashAtBroadcast, hash); // durable before the network saw it
  assert.equal(store.grant(grant.id).status, 'awaiting_owner'); assert.equal(store.active().id, 'grant');
  assert.equal(store.grant(grant.id).serialized, 'serialized-permission');
  // While the approval is in flight, nothing can spend and nothing is resent.
  assert.deepEqual((await service.intent('during-approval', intent)).body.failed, ['account_busy']);
  assert.equal((await service.authorize(grant.id, { [digestA]: sig, [digestB]: sig })).body.failed[0], 'not_prepared'); // the signed operation is single-use
  assert.equal((await service.prepareOwner(grant.id)).body.failed[0], 'account_busy');
  assert.equal(backend.sends, 1);
  backend.found = true;
  await service.reconcile();
  assert.equal(store.active().id, grant.id);
  assert.equal(store.grant('grant').status, 'expired');
  assert.equal(store.request(`owner-${grant.id}`).status, 'executed');
  assert.equal(store.grant(grant.id).authorization, undefined);
});
test('a new approval replaces a live session; refused for an expired window or a changed signing request', async t => {
  const { service, store, backend } = fixture(t);
  backend.now = async () => 500; // the fixture's active session (window 100-1000) is still running
  const replacement = service.ruleset({ ...rules, window: { start: 400, end: 5000 } }).body;
  assert.equal((await service.prepareOwner(replacement.id)).code, 200);
  await service.authorize(replacement.id, { [digestA]: sig, [digestB]: sig });
  assert.equal(store.active().id, replacement.id); assert.equal(store.grant('grant').status, 'expired');
  backend.sends = 0;
  const grant = service.ruleset(next).body;
  backend.now = async () => 6000;
  assert.equal((await service.prepareOwner(grant.id)).body.failed[0], 'window_closed');
  backend.now = async () => 2000;
  assert.equal((await service.authorize(grant.id, { [digestA]: sig })).body.failed[0], 'not_prepared');
  assert.equal((await service.prepareOwner('f'.repeat(64))).code, 404);
  await service.prepareOwner(grant.id);
  backend.finalizeAuthorization = async () => { throw new MissingSignature('x'); };
  assert.equal((await service.authorize(grant.id, { [digestA]: sig, [digestB]: sig })).body.failed[0], 'authorization_changed');
  assert.equal(backend.sends, 0); assert.equal(store.request(`owner-${grant.id}`), null);
});
test('a reverted owner approval never activates the ruleset', async t => {
  const { service, store, backend } = fixture(t);
  const grant = service.ruleset(next).body;
  await service.prepareOwner(grant.id);
  backend.receipt = async () => ({ success: false, receipt: { transactionHash: hash } });
  const sent = await service.authorize(grant.id, { [digestA]: sig, [digestB]: sig });
  assert.equal(sent.body.status, 'rejected'); assert.deepEqual(sent.body.failed, ['owner_approval_reverted']);
  assert.equal(store.active().id, 'grant'); assert.equal(store.pending().length, 0);
});
test('owner routes require the owner token', async t => {
  const { service } = fixture(t);
  const cfg = { agentToken: 'a'.repeat(64), ownerToken: 'b'.repeat(64), origins: new Set() };
  const server = httpServer(service, cfg);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (token, path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const grant = service.ruleset(next).body;
  assert.equal((await post(cfg.agentToken, `/ruleset/${grant.id}/prepare`)).status, 403);
  assert.equal((await post(cfg.agentToken, `/ruleset/${grant.id}/authorize`, { signatures: {} })).status, 403);
  const prepared = await post(cfg.ownerToken, `/ruleset/${grant.id}/prepare`);
  assert.equal(prepared.status, 200); assert.equal((await prepared.json()).requests.length, 2);
});
