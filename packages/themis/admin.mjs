import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData } from 'viem';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toPermissionValidator, serializePermissionAccount } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { config, readEnvironment, local } from './lib/config.mjs';
import { createChainBackend, buildPolicies, units, normalizeKey, chain, entryPoint, kernelVersion, pool, usdc, tokenAbi } from './lib/session.mjs';
import { Store } from './lib/store.mjs';
import { fingerprint, publicGrant } from './lib/service.mjs';
import { validateRuleset } from './lib/validation.mjs';
import { http } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';

async function main() {
  const cfg = config();
  // Owner commands have their own process lock, separate from the HTTP server.
  const lockPath = `${local}admin.lock`;
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Inspect the invalid admin lock before retrying.');
    try { process.kill(pid, 0); throw new Error('Another owner command is running.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  const unlock = () => { if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); };
  process.once('exit', unlock);
  const store = new Store(cfg.dbPath);
  const backend = createChainBackend(cfg);
  try {
    await backend.assertChain();
    const command = process.argv[2];
    if (command === 'reconcile') {
      for (const job of store.pending().filter(row => row.status === 'authorizing')) {
        if (!job.userOpHash) { job.status = 'rejected'; job.failed = ['interrupted_before_submission']; store.update(job); continue; }
        const receipt = await backend.receipt(job.userOpHash);
        if (!receipt) { console.log(`Owner approval ${job.userOpHash} is still unresolved; no resubmission.`); continue; }
        if (receipt.success) {
          const grant = store.grant(job.grantId);
          if (!grant?.serialized) throw new Error('Saved authorization is missing; inspect before proceeding.');
          store.activate(grant);
        }
        job.status = receipt.success ? 'executed' : 'rejected';
        job.failed = receipt.success ? [] : ['owner_approval_reverted'];
        job.txHash = receipt.receipt.transactionHash; store.update(job);
        console.log(`Owner approval reconciled: ${job.status}, ${job.txHash}`);
      }
      return;
    }
    if (store.pending().length) throw new Error('Resolve in-flight operations before changing authorization. For owner approvals use admin.mjs reconcile.');
    const now = Number((await backend.client.getBlock()).timestamp);
    if (command === 'import-a2') {
      if (store.active()) { console.log('An active ruleset is already present; no changes made.'); return; }
      const state = JSON.parse(readFileSync(new URL('./a2-state.json', import.meta.url), 'utf8'));
      if (!state.permissionSaved || !state.repayment || state.account.toLowerCase() !== cfg.account.toLowerCase()) throw new Error('Expected a proven A2 session for this Kernel.');
      const rules = { account: cfg.account, chainId: 11155111, window: { start: state.validAfter, end: state.validUntil }, trigger: { healthFactorBelow: 1.15 }, allow: [{ protocol: 'aave-v3', action: 'repay', asset: 'USDC' }], maxPerAction: state.maxPerCall, maxActions: state.maxUserOperations };
      if (validateRuleset(rules, cfg.account).length || now >= rules.window.end) throw new Error('A2 rules invalid or expired.');
      const { serialized } = JSON.parse(readFileSync(`${local}session-permission.json`, 'utf8'));
      const grant = { id: fingerprint(rules), status: 'active', rules, serialized, permissionId: state.permissionId, ratePolicy: state.policies.find(item => item.type === 'rate-limit').address, source: 'a2' };
      const snapshot = await backend.snapshot(grant);
      const total = units(rules.maxPerAction) * BigInt(rules.maxActions);
      if (snapshot.allowance > total) throw new Error('A2 allowance exceeds its mandate.');
      grant.initialSpent = (total - snapshot.allowance).toString();
      store.activate(grant);
      console.log(JSON.stringify({ ...publicGrant(grant), remainingUserOperations: snapshot.remaining, importedSpentUnits: grant.initialSpent }, null, 2));
      return;
    }
    if (command !== 'authorize' || !process.argv[3]) throw new Error('Use admin.mjs import-a2 or admin.mjs authorize RULESET_ID [--send].');
    const grant = store.grant(process.argv[3]);
    if (!grant || validateRuleset(grant.rules, cfg.account).length) throw new Error('Unknown or invalid ruleset.');
    if (grant.status === 'active') { console.log('Already authorized; allowance was not reset.'); return; }
    if (grant.status !== 'awaiting_owner' || now >= grant.rules.window.end) throw new Error('Ruleset is not eligible for authorization.');
    const old = store.active();
    if (old && now <= old.rules.window.end) throw new Error('Existing session must expire before replacing it; allowance is shared.');
    // Also protect an A2 grant if it has not yet been imported into the API DB.
    const a2Path = new URL('./a2-state.json', import.meta.url);
    if (!old && existsSync(a2Path) && now <= JSON.parse(readFileSync(a2Path, 'utf8')).validUntil) throw new Error('Import the still-valid A2 session instead of overlapping mandates.');
    console.log(JSON.stringify(publicGrant(grant), null, 2));
    if (!process.argv.includes('--send')) { console.log('Preview only. Add --send to sign authorization and set the exact allowance.'); return; }
    const job = { id: `owner-${grant.id}`, grantId: grant.id, fingerprint: grant.id, status: 'authorizing', internal: true, createdAt: new Date().toISOString() };
    if (store.request(job.id)) store.update(job); else store.insert(job); // Blocks API spending during authorization.
    try {
      const owner = privateKeyToAccount(normalizeKey(readEnvironment().DEV_OWNER_PRIVATE_KEY));
      const validator = await signerToEcdsaValidator(backend.client, { signer: owner, entryPoint, kernelVersion });
      const ownerAccount = await createKernelAccount(backend.client, { plugins: { sudo: validator }, entryPoint, kernelVersion, index: 0n });
      if (ownerAccount.address.toLowerCase() !== cfg.account.toLowerCase()) throw new Error('Owner does not derive the configured Kernel.');
      const signer = await toECDSASigner({ signer: privateKeyToAccount(normalizeKey(cfg.sessionKey)) });
      const policies = buildPolicies(grant.rules);
      const permission = await toPermissionValidator(backend.client, { signer, policies, entryPoint, kernelVersion });
      const account = await createKernelAccount(backend.client, { plugins: { sudo: validator, regular: permission }, entryPoint, kernelVersion, index: 0n });
      const serialized = await serializePermissionAccount(account);
      const ownerClient = createKernelAccountClient({ account: ownerAccount, client: backend.client, chain, bundlerTransport: http(cfg.bundler, { retryCount: 0 }) });
      const amount = units(grant.rules.maxPerAction) * BigInt(grant.rules.maxActions);
      const prepared = await ownerClient.prepareUserOperation({ calls: [{ to: usdc, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [pool, amount] }) }] });
      const { signature: _stub, calls: _calls, account: _account, ...operation } = prepared;
      operation.signature = await ownerAccount.signUserOperation(operation);
      const hash = getUserOperationHash({ userOperation: operation, chainId: chain.id, entryPointAddress: entryPoint.address, entryPointVersion: '0.7' });
      Object.assign(grant, { serialized, permissionId: permission.getIdentifier(), ratePolicy: `0x${policies[2].getPolicyInfoInBytes().slice(-40)}`, initialSpent: '0' });
      store.putGrant(grant);
      job.userOpHash = hash; store.update(job); // Persist BEFORE broadcasting.
      await backend.broadcast({ operation, hash });
      const receipt = await ownerClient.waitForUserOperationReceipt({ hash, timeout: 120000 });
      job.txHash = receipt.receipt.transactionHash;
      if (!receipt.success) { job.status = 'rejected'; job.failed = ['owner_approval_reverted']; store.update(job); throw new Error('Owner approval reverted.'); }
      store.activate(grant);
      job.status = 'executed'; store.update(job);
      console.log(`Ruleset authorized. Approval transaction: ${job.txHash}`);
    } catch (error) {
      if (!job.userOpHash) { job.status = 'rejected'; job.failed = ['owner_preparation_failed']; store.update(job); }
      throw error; // A known hash with an unknown outcome remains blocked.
    }
  } finally { store.close(); unlock(); }
}
main().catch(error => { console.error(error.shortMessage ? 'Owner authorization failed; inspect the saved job before retrying. RPC details omitted.' : error.message.replace(/https?:\/\/[^\s]+/g, '[redacted]')); process.exitCode = 1; });
