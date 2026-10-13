// getUserAccountData(address) selector, called with a raw eth_call so the agent needs no dependencies.
const SELECTOR = "0xbf92857c";
const MAX_UINT256 = 2n ** 256n - 1n;

export const DEFAULT_AAVE_POOL = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";

/** @returns {Promise<{healthFactor: number | null, collateralUsd: number, debtUsd: number}>} healthFactor is null when there is no debt */
export async function readHealth({ rpcUrl, account, pool = DEFAULT_AAVE_POOL }) {
  const data = SELECTOR + account.slice(2).toLowerCase().padStart(64, "0");
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: pool, data }, "latest"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);

  const hex = json.result.slice(2);
  const word = (i) => BigInt("0x" + hex.slice(i * 64, (i + 1) * 64));
  const hf = word(5);
  return {
    healthFactor: hf === MAX_UINT256 ? null : Number(hf) / 1e18,
    collateralUsd: Number(word(0)) / 1e8,
    debtUsd: Number(word(1)) / 1e8,
  };
}
