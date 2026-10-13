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
  return {
    hermes: {
      apiKey: need("VENICE_API_KEY"),
      baseUrl: (process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1").replace(/\/$/, ""),
      model: process.env.VENICE_MODEL || "hermes-3-llama-3.1-405b",
      themisUrl: process.env.THEMIS_INTENT_URL || "http://localhost:3000/api/intent",
    },
    trigger: Number(process.env.HEALTH_THRESHOLD || 1.15),
    pollMs: Number(process.env.POLL_MS || 5000),
    cooldownMs: Number(process.env.COOLDOWN_MS || 60_000),
    chain: () => ({
      rpcUrl: need("SEPOLIA_RPC_URL"),
      account: need("KERNEL_ADDRESS"),
      pool: process.env.AAVE_POOL_ADDRESS || DEFAULT_AAVE_POOL,
    }),
  };
}
