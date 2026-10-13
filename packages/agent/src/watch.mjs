// Polls the health factor and wakes Hermes only when it drops below the trigger.
import { loadConfig } from "./config.mjs";
import { readHealth } from "./health.mjs";
import { wake } from "./wake.mjs";

const cfg = loadConfig();
const chain = cfg.chain();
const stamp = () => new Date().toLocaleTimeString();
const log = (line) => console.log(`[${stamp()}] ${line}`);

let wakeInFlight = false;
let lastWake = 0;

async function tick() {
  let health;
  try {
    health = await readHealth(chain);
  } catch (e) {
    log(`health read failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const { healthFactor } = health;
  log(`health factor ${healthFactor === null ? "no debt" : healthFactor.toFixed(3)} (trigger ${cfg.trigger})`);

  if (healthFactor === null || healthFactor >= cfg.trigger) return;
  if (wakeInFlight || Date.now() - lastWake < cfg.cooldownMs) return;

  wakeInFlight = true;
  lastWake = Date.now();
  log(`below trigger, waking Hermes (${cfg.hermes.mode})`);
  try {
    const { summary } = await wake({
      situation: { ...health, trigger: cfg.trigger },
      config: cfg.hermes,
      log,
    });
    log(`Hermes done. ${summary}`);
  } catch (e) {
    log(`Hermes failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    wakeInFlight = false;
  }
}

log(`watching ${chain.account} every ${cfg.pollMs}ms, Themis at ${cfg.hermes.themisUrl}, mode ${cfg.hermes.mode}`);
await tick();
setInterval(tick, cfg.pollMs);
