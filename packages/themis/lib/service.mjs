import { createHash } from 'node:crypto';
import { buildPolicies, units } from './session.mjs';
import { validateIntent, validateRuleset, checkLimits } from './validation.mjs';
import { MissingSignature, isDigest, isSignature, encodeOperation, decodeOperation } from './owner.mjs';
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function publicGrant(grant) {
  if (!grant) return null;
  return { id: grant.id, status: grant.status, rules: grant.rules, permissionId: grant.permissionId, policyPreview: grant.policyPreview };
}
export function result(row) {
  const base = { requestId: row.id, status: row.status };
  if (row.status === 'executed') return { ...base, txHash: row.txHash };
  if (row.status === 'pending') return { ...base, userOpHash: row.userOpHash };
  return { ...base, failed: row.failed || [] };
}
export class Service {
  constructor({ store, backend, account }) { Object.assign(this, { store, backend, account }); this.tail = Promise.resolve(); }
  serial(work) { const next = this.tail.then(work); this.tail = next.catch(() => {}); return next; }
  ruleset(rules) {
    const failed = validateRuleset(rules, this.account);
    if (failed.length) return { code: 400, body: { status: 'rejected', failed } };
    const id = fingerprint(rules);
    let grant = this.store.grant(id);
    if (!grant) {
      const policies = buildPolicies(rules);
      grant = { id, status: 'awaiting_owner', createdAt: new Date().toISOString(), rules, policyPreview: policies.map(policy => ({ type: policy.policyParams.type, address: `0x${policy.getPolicyInfoInBytes().slice(-40)}` })) };
      this.store.putGrant(grant);
    }
    return { code: grant.status === 'active' ? 200 : 202, body: publicGrant(grant) };
  }
  // Newest first, including pending proposals; a proposal whose window has ended reads as expired.
  rulesets(limit = 10) {
    const now = Math.floor(Date.now() / 1000);
    return this.store.grants()
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, limit)
      .map(grant => publicGrant(grant.status === 'awaiting_owner' && grant.rules.window.end <= now ? { ...grant, status: 'expired' } : grant));
  }
  async reconcile() {
    for (const row of this.store.pending()) {
      if (!['pending', 'authorizing'].includes(row.status) || !row.userOpHash) continue;
      let receipt;
      try { receipt = await this.backend.receipt(row.userOpHash); } catch { continue; }
      if (!receipt) continue;
      if (row.status === 'authorizing') {
        // The owner's approval landed: only now does the ruleset become the active one.
        row.txHash = receipt.receipt.transactionHash; row.updatedAt = new Date().toISOString();
        if (receipt.success) { this.store.activate(this.store.grant(row.grantId)); row.status = 'executed'; row.failed = []; }
        else { row.status = 'rejected'; row.failed = ['owner_approval_reverted']; }
        this.store.update(row); continue;
      }
      row.status = receipt.success ? 'executed' : 'rejected';
      row.txHash = receipt.receipt.transactionHash;
      row.failed = receipt.success ? [] : ['execution_reverted'];
      row.updatedAt = new Date().toISOString(); this.store.update(row);
    }
  }
  // Run only after taking the process lock. A checking row has no signed/hash
  // persisted and cannot have been broadcast; pending rows must be reconciled.
  recoverPreparation() {
    for (const row of this.store.pending()) if (row.status === 'checking' || (row.status === 'authorizing' && !row.userOpHash)) { row.status = 'rejected'; row.failed = ['interrupted_before_submission']; this.store.update(row); }
  }
  // Owner authorization, in two phases. The owner's key (a Ledger in the browser) never reaches this server:
  // prepare reports exactly what must be signed; authorize applies the signatures to those same objects.
  prepareOwner(id) { return this.serial(() => this.processOwner(id, null)); }
  authorize(id, signatures) { return this.serial(() => this.processOwner(id, signatures)); }
  async processOwner(id, signatures) {
    const refuse = (code, ...failed) => ({ code, body: { status: 'rejected', failed } });
    const grant = typeof id === 'string' ? this.store.grant(id) : null;
    if (!grant) return refuse(404, 'unknown_ruleset');
    if (grant.status !== 'awaiting_owner') return refuse(409, 'ruleset_not_pending');
    if (validateRuleset(grant.rules, this.account).length) return refuse(400, 'invalid_ruleset');
    if (signatures) {
      const entries = signatures && typeof signatures === 'object' && !Array.isArray(signatures) ? Object.entries(signatures) : [];
      if (!grant.authorization) return refuse(409, 'not_prepared');
      if (entries.some(([digest, signature]) => !isDigest(digest) || !isSignature(signature)) || entries.length > 4) return refuse(400, 'invalid_signatures');
    }
    await this.reconcile();
    if (this.store.pending().length) return refuse(409, 'account_busy');
    let now;
    try { now = await this.backend.now(); } catch { return refuse(503, 'chain_unavailable'); }
    if (now >= grant.rules.window.end) return refuse(409, 'window_closed');
    // A new approval may replace a live session: the owner's approve() resets the pool allowance to exactly the
    // new mandate's total, and that allowance is the on-chain cap shared by every permission on this account,
    // so the old session can never add to what the new mandate allows. Themis only signs for the active grant.
    if (!signatures) {
      let prepared;
      try { prepared = await this.backend.prepareAuthorization(grant); } catch { return refuse(503, 'authorization_unavailable'); }
      this.store.putGrant({ ...grant, authorization: { hash: prepared.hash, operation: encodeOperation(prepared.operation), requestIds: prepared.requests.map(request => request.id), preparedAt: new Date().toISOString() } });
      return { code: 200, body: { id: grant.id, status: 'awaiting_signatures', hash: prepared.hash, owner: prepared.owner, allowanceUnits: prepared.amount.toString(), sessionKey: prepared.sessionKey, account: grant.rules.account, requests: prepared.requests } };
    }
    if (grant.authorization.requestIds.some(digest => !signatures[digest])) return refuse(400, 'missing_signature');
    let finalized;
    try { finalized = await this.backend.finalizeAuthorization(grant, { operation: decodeOperation(grant.authorization.operation), hash: grant.authorization.hash }, signatures); }
    catch (error) { return refuse(error instanceof MissingSignature ? 409 : 503, error instanceof MissingSignature ? 'authorization_changed' : 'authorization_unavailable'); }
    const job = { id: `owner-${grant.id}`, grantId: grant.id, fingerprint: grant.id, status: 'authorizing', internal: true, userOpHash: finalized.hash, createdAt: new Date().toISOString(), failed: [] };
    // Persist the hash and the session material BEFORE the network sees the operation; the in-flight row blocks all spending meanwhile.
    try { if (this.store.request(job.id)) this.store.update(job); else this.store.insert(job); } catch { return refuse(409, 'account_busy'); }
    this.store.putGrant({ ...grant, authorization: undefined, serialized: finalized.serialized, permissionId: finalized.permissionId, ratePolicy: finalized.ratePolicy, initialSpent: '0' });
    try { await this.backend.broadcast(finalized); } catch { /* Unknown outcome: stay authorizing and reconcile. Never resend. */ }
    await this.reconcile();
    const current = this.store.request(job.id);
    return { code: current.status === 'authorizing' ? 202 : 200, body: { id: grant.id, status: current.status === 'executed' ? 'active' : current.status === 'authorizing' ? 'authorizing' : 'rejected', userOpHash: current.userOpHash, txHash: current.txHash, failed: current.failed } };
  }
  intent(id, payload) { return this.serial(() => this.processIntent(id, payload)); }
  async processIntent(id, payload) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) return { code: 400, body: { status: 'rejected', failed: ['invalid_idempotency_key'] } };
    await this.reconcile();
    const digest = fingerprint(payload);
    const existing = this.store.request(id);
    if (existing) return existing.fingerprint !== digest ? { code: 409, body: { status: 'rejected', failed: ['idempotency_conflict'] } } : { code: existing.status === 'pending' ? 202 : 200, body: result(existing) };
    const row = { id, fingerprint: digest, intent: payload, status: 'checking', createdAt: new Date().toISOString(), failed: [] };
    const reject = (failed, code = 200) => { row.status = 'rejected'; row.failed = failed; if (this.store.request(id)) this.store.update(row); else this.store.insert(row); return { code, body: result(row) }; };
    const invalid = validateIntent(payload);
    if (invalid.length) return reject(invalid);
    const grant = this.store.active();
    if (!grant) return reject(['no_active_ruleset']);
    row.grantId = grant.id;
    row.amountUnits = units(payload.amount).toString();
    if (this.store.pending().length) return reject(['account_busy'], 409);
    // SQLite's unique in-flight index also protects against another process.
    try { this.store.insert(row); } catch { return { code: 409, body: { status: 'rejected', failed: ['account_busy'] } }; }
    let snapshot;
    try { snapshot = await this.backend.snapshot(grant); } catch { return reject(['chain_unavailable'], 503); }
    const failed = checkLimits(payload, grant.rules, snapshot, this.store.spent(grant));
    if (failed.length) return reject(failed);
    let prepared;
    try { prepared = await this.backend.prepare(grant, payload); } catch { return reject(['simulation_failed']); }
    // Recheck time after potentially slow simulation; no new nonce can be sent
    // by this server while this request occupies the persisted in-flight slot.
    try { snapshot = await this.backend.snapshot(grant); } catch { return reject(['chain_unavailable'], 503); }
    const lateFailures = checkLimits(payload, grant.rules, snapshot, this.store.spent(grant));
    if (lateFailures.length) return reject(lateFailures);
    row.status = 'pending'; row.userOpHash = prepared.hash; row.updatedAt = new Date().toISOString();
    this.store.update(row); // Durable BEFORE network submission, including its hash.
    try { await this.backend.broadcast(prepared); } catch { /* Unknown outcome: keep pending. Never resign or resend. */ }
    await this.reconcile();
    const current = this.store.request(id);
    return { code: current.status === 'pending' ? 202 : 200, body: result(current) };
  }
}
