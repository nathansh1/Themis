"use client";

import type { HealthSnapshot } from "@/lib/aave";
import { usePoll } from "@/lib/use-poll";

function tone(hf: number | null) {
  if (hf === null) return "text-green-600";
  if (hf < 1.1) return "text-red-600";
  if (hf < 1.3) return "text-amber-500";
  return "text-green-600";
}

export default function HealthFactor() {
  const { data, error } = usePoll<HealthSnapshot>("/api/health", 5000);

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-foreground/60">Aave health factor</h2>
      {data ? (
        <>
          <p className={`text-5xl font-semibold tabular-nums ${tone(data.healthFactor)}`}>
            {data.healthFactor === null ? "No debt" : data.healthFactor.toFixed(2)}
          </p>
          <p className="text-sm text-foreground/60">
            Collateral ${Number(data.collateralUsd).toFixed(2)} · Debt ${Number(data.debtUsd).toFixed(2)} ·{" "}
            <code className="font-mono">{data.account.slice(0, 6)}…{data.account.slice(-4)}</code>
          </p>
        </>
      ) : (
        !error && <p className="text-sm text-foreground/60">Loading…</p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
