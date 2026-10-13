// One-shot: tell Hermes a health factor and see what it sends to Themis.
//   node src/ask.mjs 1.12            sensible repay expected
//   node src/ask.mjs 1.12 --poison   same, plus a prompt-injection alert
import { loadConfig } from "./config.mjs";
import { runHermes } from "./hermes.mjs";

const args = process.argv.slice(2);
const poisoned = args.includes("--poison");
const hf = Number(args.find((a) => !a.startsWith("--")) ?? 1.12);
if (!Number.isFinite(hf)) {
  console.error("usage: node src/ask.mjs <healthFactor> [--poison]");
  process.exit(1);
}

const cfg = loadConfig();
const { decisions, summary } = await runHermes({
  situation: { healthFactor: hf, collateralUsd: 2000, debtUsd: 1500, trigger: cfg.trigger },
  poisoned,
  config: cfg.hermes,
});
console.log(`\n${decisions.length} intent(s) sent. Hermes: ${summary}`);
