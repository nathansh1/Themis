// The two tools Hermes gets. Shared by the MCP server (real Hermes) and the direct-Venice fallback.
// Themis builds all calldata itself; nothing here lets the agent supply any.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const CHAIN_ID = 11155111;
const DEFAULT_TRIGGER = 1.15;
const DEFAULT_ACTIONS = 3;
const DEFAULT_WINDOW_SECONDS = 8 * 3600;
// Themis's own ceilings (packages/themis/lib/validation.mjs): mirrored here so Hermes gets a clear error up front.
const MAX_PER_ACTION = 500;
const MAX_ACTIONS = 3;
const MAX_TRIGGER = 10;
const POLL_EVERY_MS = 3000;
const POLL_FOR_MS = 75_000;

export const TOOL_DEFS = [
  {
    name: "propose_ruleset",
    description:
      "Turn the user's protection rule into a ruleset and send it to Themis as a PENDING proposal. " +
      "Nothing is active until the user approves it on their Ledger. " +
      'Use this when the user says things like "protect my position overnight, max $1,500". ' +
      "The only supported action is repaying USDC debt on Aave V3. " +
      `Themis allows at most ${MAX_ACTIONS} repay actions of at most ${MAX_PER_ACTION} USDC each, so the largest total cap is ${MAX_ACTIONS * MAX_PER_ACTION} USDC. ` +
      "The per-action cap is totalCapUsdc divided by maxActions. " +
      "After calling, tell the user plainly what was proposed (cap, number of repays, trigger, window) and that they must approve it on the Ledger.",
    inputSchema: {
      type: "object",
      properties: {
        totalCapUsdc: {
          type: "number",
          description: `Most USDC the agent may repay in total, e.g. 1500. At most ${MAX_ACTIONS * MAX_PER_ACTION}.`,
        },
        maxActions: {
          type: "integer",
          description: `Most repay actions allowed, 1 to ${MAX_ACTIONS} (default ${DEFAULT_ACTIONS}).`,
        },
        healthFactorBelow: {
          type: "number",
          description: `Only act when the health factor is below this (default ${DEFAULT_TRIGGER}).`,
        },
        windowStart: {
          type: "string",
          description: 'ISO 8601 timestamp with UTC offset, e.g. "2026-10-13T22:00:00-05:00". Default: now.',
        },
        windowEnd: {
          type: "string",
          description: `ISO 8601 timestamp with UTC offset. Default: ${DEFAULT_WINDOW_SECONDS / 3600} hours after the start. "Overnight" means roughly 22:00 to 06:00 local time.`,
        },
      },
      required: ["totalCapUsdc"],
    },
  },
  {
    name: "send_intent",
    description:
      "Ask Themis to perform an action on the user's Aave account. Themis checks it against the approved ruleset " +
      "and answers executed (with a tx hash) or rejected (with the list of failed checks). " +
      "The call waits for an on-chain result, which can take up to a minute. " +
      'Normally action is "repay" and asset is "USDC". Amount is in whole tokens. ' +
      "If Themis rejects, read the failed checks; adjust once if that makes sense, otherwise stop and explain.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: 'What to do. Normally "repay".' },
        asset: { type: "string", description: 'Token symbol, normally "USDC".' },
        amount: { type: "string", description: 'Amount in whole tokens, e.g. "250".' },
        recipient: { type: "string", description: "Only for actions that send tokens to another address." },
        reason: { type: "string", description: "One short factual sentence explaining why." },
      },
      required: ["action", "asset", "amount", "reason"],
    },
  },
];

function trimmed(n) {
  return n.toFixed(6).replace(/\.?0+$/, "");
}

export function buildRuleset(args, account) {
  if (!account) throw new Error("No Kernel account is configured (set KERNEL_ACCOUNT_ADDRESS), so there is no account to protect.");
  const total = Number(args.totalCapUsdc);
  if (!Number.isFinite(total) || total <= 0) throw new Error("totalCapUsdc must be a positive number.");
  const maxActions = args.maxActions === undefined ? DEFAULT_ACTIONS : Number(args.maxActions);
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > MAX_ACTIONS) {
    throw new Error(`maxActions must be a whole number from 1 to ${MAX_ACTIONS}.`);
  }
  const perAction = total / maxActions;
  if (perAction > MAX_PER_ACTION) {
    throw new Error(
      `A cap of ${total} USDC over ${maxActions} actions is ${trimmed(perAction)} USDC each, above the ${MAX_PER_ACTION} USDC per-action limit. ` +
        `The most Themis allows is ${MAX_PER_ACTION * MAX_ACTIONS} USDC in total.`,
    );
  }
  const trigger = args.healthFactorBelow === undefined ? DEFAULT_TRIGGER : Number(args.healthFactorBelow);
  if (!Number.isFinite(trigger) || trigger <= 1 || trigger > MAX_TRIGGER) {
    throw new Error(`healthFactorBelow must be above 1.0 (the liquidation line) and at most ${MAX_TRIGGER}.`);
  }

  const now = Math.floor(Date.now() / 1000);
  const parse = (label, text) => {
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) throw new Error(`${label} is not a valid ISO 8601 timestamp: ${text}`);
    return Math.floor(ms / 1000);
  };
  const start = args.windowStart ? parse("windowStart", args.windowStart) : now;
  const end = args.windowEnd ? parse("windowEnd", args.windowEnd) : start + DEFAULT_WINDOW_SECONDS;
  if (end <= start) throw new Error("windowEnd must be after windowStart.");
  if (end <= now) throw new Error("That window has already ended.");

  return {
    account,
    chainId: CHAIN_ID,
    window: { start, end },
    trigger: { healthFactorBelow: trigger },
    allow: [{ protocol: "aave-v3", action: "repay", asset: "USDC" }],
    maxPerAction: trimmed(perAction),
    maxActions,
  };
}

const credentialsFile = new URL("../../themis/.local/api-credentials.json", import.meta.url);

function credentials() {
  try {
    return existsSync(credentialsFile) ? JSON.parse(readFileSync(credentialsFile, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * Bearer token for Themis. Env wins; otherwise the local credentials file Themis generates, so no
 * secret has to be copied into the Hermes config. The agent uses only the agent token: it may propose
 * rulesets (pending until the owner authorizes) and send intents, nothing more.
 */
function token() {
  const file = credentials();
  return process.env.THEMIS_AGENT_TOKEN || file.agentToken;
}

function authHeaders() {
  const t = token();
  return t ? { authorization: `Bearer ${t}` } : {};
}

async function request(method, url, { body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Themis returned ${res.status} with a non-JSON body`);
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Themis answers `pending` (202) until the UserOperation lands; wait for the final answer.
async function awaitFinal(base, first, headers) {
  let current = first;
  const deadline = Date.now() + POLL_FOR_MS;
  while (current.status === "pending" && current.requestId && Date.now() < deadline) {
    await sleep(POLL_EVERY_MS);
    current = (await request("GET", `${base}/intent/${encodeURIComponent(current.requestId)}`, { headers })).body;
  }
  return current;
}

/**
 * Run a tool and return its result object. Throws on bad arguments or an unreachable Themis.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{themisUrl: string, account?: string}} ctx themisUrl is Themis's base, e.g. http://127.0.0.1:3001
 */
export async function callTool(name, args, ctx) {
  const base = ctx.themisUrl.replace(/\/$/, "");
  if (name === "propose_ruleset") {
    const ruleset = buildRuleset(args, ctx.account);
    return (await request("POST", `${base}/ruleset`, { body: ruleset, headers: authHeaders() })).body;
  }
  if (name === "send_intent") {
    // Themis accepts exactly action, asset, amount and reason; an empty optional field would be a false rejection.
    const intent = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const headers = { ...authHeaders(), "idempotency-key": `themis-${randomUUID()}` };
    const first = (await request("POST", `${base}/intent`, { body: intent, headers })).body;
    return awaitFinal(base, first, authHeaders());
  }
  throw new Error(`unknown tool ${name}`);
}
