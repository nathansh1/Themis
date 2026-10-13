// One entry point for waking the agent. AGENT_MODE=hermes (default) runs the real Hermes Agent;
// AGENT_MODE=direct runs the plain Venice tool loop and should be disclosed as such.
import { runHermesAgent } from "./hermes-agent.mjs";
import { runHermes, wakeMessage } from "./hermes.mjs";

export async function wake({ situation, poisoned, userMessage, config, log = console.log }) {
  if (config.mode === "direct") return runHermes({ situation, poisoned, userMessage, config, log });
  const summary = await runHermesAgent(wakeMessage({ situation, poisoned, userMessage }), config);
  return { decisions: [], summary };
}
