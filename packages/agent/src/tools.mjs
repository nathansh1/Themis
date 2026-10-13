// The two tools Hermes gets. Shared by the MCP server (real Hermes) and the direct-Venice fallback.
// Themis builds all calldata itself; nothing here lets the agent supply any.

const CHAIN_ID = 11155111;
const DEFAULT_TRIGGER = 1.15;
const DEFAULT_ACTIONS = 3;
const DEFAULT_WINDOW_SECONDS = 8 * 3600;

export const TOOL_DEFS = [
  {
    name: "propose_ruleset",
    description:
      "Turn the user's protection rule into a ruleset and send it to Themis as a PENDING proposal. " +
      "Nothing is active until the user approves it on their Ledger. " +
      'Use this when the user says things like "protect my position overnight, max $1,500". ' +
      "The only supported action is repaying USDC debt on Aave V3. " +
      "The per-action cap is totalCapUsdc divided by maxActions. " +
      "After calling, tell the user plainly what was proposed (cap, number of repays, trigger, window) and that they must approve it on the Ledger.",
    inputSchema: {
      type: "object",
      properties: {
        totalCapUsdc: { type: "number", description: "Most USDC the agent may repay in total, e.g. 1500." },
        maxActions: { type: "integer", description: `Most repay actions allowed (default ${DEFAULT_ACTIONS}).` },
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

function money(n) {
  return String(Number(n.toFixed(2)));
}

export function buildRuleset(args, account) {
  if (!account) throw new Error("KERNEL_ADDRESS is not configured, so there is no account to protect.");
  const total = Number(args.totalCapUsdc);
  if (!Number.isFinite(total) || total <= 0) throw new Error("totalCapUsdc must be a positive number.");
  const maxActions = args.maxActions === undefined ? DEFAULT_ACTIONS : Number(args.maxActions);
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 20) {
    throw new Error("maxActions must be a whole number between 1 and 20.");
  }
  const trigger = args.healthFactorBelow === undefined ? DEFAULT_TRIGGER : Number(args.healthFactorBelow);
  if (!Number.isFinite(trigger) || trigger <= 1 || trigger > 3) {
    throw new Error("healthFactorBelow must be above 1.0 (the liquidation line) and at most 3.");
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
    maxPerAction: money(total / maxActions),
    maxActions,
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Themis returned ${res.status} with a non-JSON body`);
  return json;
}

/**
 * Run a tool and return its result object. Throws on bad arguments or an unreachable Themis.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{themisUrl: string, account?: string}} ctx themisUrl is the base, e.g. http://localhost:3000/api
 */
export async function callTool(name, args, ctx) {
  const base = ctx.themisUrl.replace(/\/$/, "");
  if (name === "propose_ruleset") {
    const ruleset = buildRuleset(args, ctx.account);
    return postJson(`${base}/ruleset`, ruleset);
  }
  if (name === "send_intent") {
    return postJson(`${base}/intent`, args);
  }
  throw new Error(`unknown tool ${name}`);
}
