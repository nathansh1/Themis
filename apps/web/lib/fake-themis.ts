import type { IntentResult } from "@themis/shared";

// Stand-in for Dev A's Themis service: same IntentResult shape, canned rules.
const MAX_PER_ACTION = 500;
const MAX_ACTIONS = 3;

export type LogEntry = {
  id: number;
  time: number;
  intent: unknown;
  result: IntentResult;
};

const store = globalThis as typeof globalThis & { __fakeThemisLog?: LogEntry[] };
const log = (store.__fakeThemisLog ??= []);

export function getLog(): LogEntry[] {
  return log;
}

function fakeTxHash(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function decide(intent: unknown): IntentResult {
  const i = (intent ?? {}) as Record<string, unknown>;
  const failed: string[] = [];

  if (i.action !== "repay") failed.push(`action not allowed: ${String(i.action)}`);
  if (i.asset !== "USDC") failed.push(`asset not allowed: ${String(i.asset)}`);
  const amount = Number(i.amount);
  if (!Number.isFinite(amount) || amount <= 0) failed.push("amount is not a positive number");
  else if (amount > MAX_PER_ACTION) failed.push(`over per-action cap of ${MAX_PER_ACTION} USDC`);
  const executed = log.filter((e) => e.result.status === "executed").length;
  if (executed >= MAX_ACTIONS) failed.push(`over running total of ${MAX_ACTIONS} actions`);

  return failed.length ? { status: "rejected", failed } : { status: "executed", txHash: fakeTxHash() };
}

export function record(intent: unknown, result: IntentResult): LogEntry {
  const entry = { id: log.length + 1, time: Date.now(), intent, result };
  log.push(entry);
  return entry;
}

export type PendingRuleset = { id: number; time: number; status: "pending"; ruleset: unknown };

const rulesetStore = globalThis as typeof globalThis & { __fakeThemisRulesets?: PendingRuleset[] };
const rulesets = (rulesetStore.__fakeThemisRulesets ??= []);

export function getRulesets(): PendingRuleset[] {
  return rulesets;
}

// Stand-in: the real Themis holds the proposal until the Ledger approves it.
export function propose(ruleset: unknown): PendingRuleset {
  const entry: PendingRuleset = { id: rulesets.length + 1, time: Date.now(), status: "pending", ruleset };
  rulesets.push(entry);
  return entry;
}
