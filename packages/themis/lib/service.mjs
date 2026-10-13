import { createHash } from 'node:crypto';
import { buildPolicies, units } from './session.mjs';
import { validateIntent, validateRuleset, checkLimits } from './validation.mjs';
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
      grant = { id, status: 'awaiting_owner', rules, policyPreview: policies.map(policy => ({ type: policy.policyParams.type, address: `0x${policy.getPolicyInfoInBytes().slice(-40)}` })) };
      this.store.putGrant(grant);
    }
    return { code: grant.status === 'active' ? 200 : 202, body: publicGrant(grant) };
  }
  async reconcile() {
    for (const row of this.store.pending()) {
      if (row.status !== 'pending' || !row.userOpHash) continue;
      let receipt;
      try { receipt = await this.backend.receipt(row.userOpHash); } catch { continue; }
      if (!receipt) continue;
      row.status = receipt.success ? 'executed' : 'rejected';
      row.txHash = receipt.receipt.transactionHash;
      row.failed = receipt.success ? [] : ['execution_reverted'];
      row.updatedAt = new Date().toISOString(); this.store.update(row);
    }
  }
  // Run only after taking the process lock. A checking row has no signed/hash
  // persisted and cannot have been broadcast; pending rows must be reconciled.
  recoverPreparation() {
    for (const row of this.store.pending()) if (row.status === 'checking') { row.status = 'rejected'; row.failed = ['interrupted_before_submission']; this.store.update(row); }
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
