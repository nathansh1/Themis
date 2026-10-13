import type { ActivityEntry, IntentResult, RulesetResult } from "@themis/shared";

// Stand-in for the real Themis server (packages/themis), used when THEMIS_URL is unset.
// Same shapes and the same failure codes, with canned limits.
const MAX_PER_ACTION = 500;
const MAX_ACTIONS = 3;

type Store = {
  log: ActivityEntry[];
  rulesets: RulesetResult[];
};
const g = globalThis as typeof globalThis & { __fakeThemis?: Store };
const store = (g.__fakeThemis ??= { log: [], rulesets: [] });

function fakeTxHash(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Newest first, like the real /log.
export function getLog(): ActivityEntry[] {
  return store.log;
}

export function decide(intent: unknown): IntentResult {
  const i = (intent ?? {}) as Record<string, unknown>;
  const failed: string[] = [];

  if (i.action !== "repay") failed.push("action_not_allowed");
  if (i.asset !== "USDC") failed.push("asset_not_allowed");
  const amount = Number(i.amount);
  if (!Number.isFinite(amount) || amount <= 0) failed.push("invalid_amount");
  else {
    if (amount > MAX_PER_ACTION) failed.push("over_per_action_limit");
    const spent = store.log
      .filter((e) => e.status === "executed")
      .reduce((sum, e) => sum + Number((e.intent as { amount?: unknown })?.amount ?? 0), 0);
    if (spent + amount > MAX_PER_ACTION * MAX_ACTIONS) failed.push("over_total_limit");
  }

  const requestId = crypto.randomUUID();
  return failed.length
    ? { status: "rejected", requestId, failed }
    : { status: "executed", requestId, txHash: fakeTxHash() };
}

export function record(intent: unknown, result: IntentResult): ActivityEntry {
  const now = new Date().toISOString();
  const entry: ActivityEntry = {
    id: result.requestId ?? crypto.randomUUID(),
    intent,
    status: result.status,
    createdAt: now,
    failed: result.status === "rejected" ? result.failed : [],
    ...(result.status === "executed" ? { txHash: result.txHash } : {}),
  };
  store.log.unshift(entry);
  return entry;
}

export function getRulesets(): RulesetResult[] {
  return store.rulesets.slice().reverse(); // newest first, like GET /rulesets
}

// The real Themis holds the proposal as awaiting_owner until the owner approves it.
export function propose(rules: unknown): RulesetResult {
  const entry: RulesetResult = {
    id: crypto.randomUUID(),
    status: "awaiting_owner",
    rules: rules as RulesetResult["rules"],
  };
  store.rulesets.push(entry);
  return entry;
}
