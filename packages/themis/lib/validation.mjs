import { isAddress } from 'viem';
import { units } from './session.mjs';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
export function validateRuleset(value, account) {
  const failed = [];
  if (!exactKeys(value, ['account', 'chainId', 'window', 'trigger', 'allow', 'maxPerAction', 'maxActions'])) return ['invalid_ruleset'];
  if (!isAddress(value.account || '') || value.account.toLowerCase() !== account.toLowerCase()) failed.push('account_not_allowed');
  if (value.chainId !== 11155111) failed.push('chain_not_allowed');
  if (!exactKeys(value.window, ['start', 'end']) || !Number.isSafeInteger(value.window.start) || !Number.isSafeInteger(value.window.end) || value.window.start < 0 || value.window.end <= value.window.start || value.window.end - value.window.start > 86400 || value.window.end >= 2 ** 48) failed.push('invalid_window');
  if (!exactKeys(value.trigger, ['healthFactorBelow']) || typeof value.trigger.healthFactorBelow !== 'number' || !Number.isFinite(value.trigger.healthFactorBelow) || value.trigger.healthFactorBelow <= 1 || value.trigger.healthFactorBelow > 10) failed.push('invalid_trigger');
  if (!Array.isArray(value.allow) || value.allow.length !== 1 || !exactKeys(value.allow[0], ['protocol', 'action', 'asset']) || value.allow[0].protocol !== 'aave-v3' || value.allow[0].action !== 'repay' || value.allow[0].asset !== 'USDC') failed.push('allow_not_supported');
  try { const amount = units(value.maxPerAction); if (amount <= 0n || amount > 500000000n) failed.push('invalid_limit'); } catch { failed.push('invalid_limit'); }
  if (!Number.isInteger(value.maxActions) || value.maxActions < 1 || value.maxActions > 3) failed.push('invalid_action_count');
  return failed;
}
export function validateIntent(value) {
  const failed = [];
  if (!object(value)) return ['invalid_request'];
  if (!exactKeys(value, ['action', 'asset', 'amount', 'reason'])) failed.push('invalid_fields');
  if (value.action !== 'repay') failed.push('action_not_allowed');
  if (value.asset !== 'USDC') failed.push('asset_not_allowed');
  try { if (units(value.amount) <= 0n) failed.push('invalid_amount'); } catch { failed.push('invalid_amount'); }
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000) failed.push('invalid_reason');
  return failed;
}
// Check in mandate order. The health-factor threshold is watcher configuration,
// not an authorization assertion inferred from the agent's free-text reason.
export function checkLimits(intent, rules, snapshot, spent) {
  const failed = [];
  if (snapshot.now < rules.window.start) failed.push('window_not_open');
  if (snapshot.now >= rules.window.end) failed.push('window_closed');
  const amount = units(intent.amount);
  if (amount > units(rules.maxPerAction)) failed.push('over_per_action_limit');
  if (spent + amount > units(rules.maxPerAction) * BigInt(rules.maxActions)) failed.push('over_total_limit');
  if (snapshot.remaining <= 0) failed.push('action_count_exhausted');
  if (amount > snapshot.allowance) failed.push('insufficient_allowance');
  if (amount > snapshot.balance) failed.push('insufficient_balance');
  if (snapshot.debt === 0n) failed.push('no_debt');
  return failed;
}
