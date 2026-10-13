import { kernelAccount } from "./account.mjs";
import { DEFAULT_AAVE_POOL } from "./health.mjs";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is missing. Set it in the repo's .env (see .env.example).`);
    process.exit(1);
  }
  return v;
}

export function loadConfig() {
  const mode = process.env.AGENT_MODE || "hermes";
  if (mode !== "hermes" && mode !== "direct") {
    console.error(`AGENT_MODE must be "hermes" or "direct", got "${mode}".`);
    process.exit(1);
  }
  return {
    hermes: {
      mode,
      apiKey: need("VENICE_API_KEY"),
      baseUrl: (process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1").replace(/\/$/, ""),
      model: process.env.VENICE_MODEL || "llama-3.3-70b",
      // Base URL of Themis; the agent calls <base>/ruleset and <base>/intent. Unset = the web app's built-in
      // stand-in; set it to http://127.0.0.1:3001 for the real server (the web app reads the same variable).
      themisUrl: (process.env.THEMIS_URL || "http://localhost:3000/api").replace(/\/$/, ""),
      account: kernelAccount(),
    },
    trigger: Number(process.env.HEALTH_THRESHOLD || 1.15),
    pollMs: Number(process.env.POLL_MS || 5000),
    cooldownMs: Number(process.env.COOLDOWN_MS || 60_000),
    chain: () => ({
      rpcUrl: need("SEPOLIA_RPC_URL"),
      account: kernelAccount() ?? need("KERNEL_ACCOUNT_ADDRESS"),
      pool: process.env.AAVE_POOL_ADDRESS || DEFAULT_AAVE_POOL,
    }),
  };
}
