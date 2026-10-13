// One-shot: wake the agent once and see what it does.
//   node src/ask.mjs 1.12                         told a health factor, expect a sensible repay intent
//   node src/ask.mjs 1.12 --poison                same, plus a prompt-injection alert
//   node src/ask.mjs --say "protect my position overnight, max $1,500"   expect a pending ruleset
//   --collateral=N --debt=N   override the figures Hermes is told
//   --json                    print {decisions, summary} as JSON
// Uses AGENT_MODE (hermes by default, or direct).
import { loadConfig } from "./config.mjs";
import { wake } from "./wake.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const sayAt = args.indexOf("--say");
const userMessage = sayAt >= 0 ? args[sayAt + 1] : undefined;
const poisoned = args.includes("--poison");
const asJson = args.includes("--json");
const hf = Number(args.find((a, i) => !a.startsWith("--") && i !== sayAt + 1) ?? 1.12);
if (!Number.isFinite(hf) || (sayAt >= 0 && !userMessage)) {
  console.error('usage: node src/ask.mjs <healthFactor> [--poison] | --say "<text>"  [--json]');
  process.exit(1);
}

const cfg = loadConfig();
try {
  const { decisions, summary } = await wake({
    situation: {
      healthFactor: hf,
      collateralUsd: Number(flag("collateral") ?? 2000),
      debtUsd: Number(flag("debt") ?? 1500),
      trigger: cfg.trigger,
    },
    poisoned,
    userMessage,
    config: cfg.hermes,
    log: asJson ? () => {} : console.log,
  });
  if (asJson) console.log(JSON.stringify({ decisions, summary }));
  else console.log(`\n${decisions.length} tool call(s) recorded. Hermes: ${summary}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
