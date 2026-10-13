"use client";

import type { HealthSnapshot } from "@/lib/aave";
import { usePoll } from "@/lib/use-poll";

// Mirrors the example ruleset trigger; liquidation is fixed by Aave at 1.0.
const TRIGGER = 1.15;
const SCALE_MIN = 0.8;
const SCALE_MAX = 2;

function tone(hf: number | null) {
  if (hf === null) return "text-ok";
  if (hf < 1.1) return "text-seal";
  if (hf < 1.3) return "text-warn";
  return "text-ok";
}

function pct(hf: number) {
  return Math.min(100, Math.max(0, ((hf - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100));
}

function Gauge({ hf }: { hf: number | null }) {
  const fill = hf === null ? 100 : pct(hf);
  return (
    <div className="mt-6">
      <div className="relative h-px bg-foreground/25">
        <div className="absolute left-0 top-[-1px] h-[3px] bg-foreground" style={{ width: `${fill}%` }} />
        <div className="absolute top-[-7px] h-4 w-px bg-seal" style={{ left: `${pct(1)}%` }} />
        <div className="absolute top-[-7px] h-4 w-px bg-warn" style={{ left: `${pct(TRIGGER)}%` }} />
      </div>
      <div className="relative mt-3 h-8 font-display text-[10px] uppercase tracking-[0.14em]">
        <span className="absolute -translate-x-1/2 text-seal" style={{ left: `${pct(1)}%` }}>
          Liquidation 1.00
        </span>
        <span className="absolute top-4 -translate-x-1/2 text-warn" style={{ left: `${pct(TRIGGER)}%` }}>
          Trigger {TRIGGER.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

export default function HealthFactor() {
  const { data, error } = usePoll<HealthSnapshot>("/api/health", 5000);

  return (
    <div>
      <p className="font-display text-[11px] uppercase tracking-[0.22em] text-foreground/50">Aave health factor</p>
      {data ? (
        <>
          <p className={`mt-1 font-display text-7xl font-semibold tabular-nums leading-none ${tone(data.healthFactor)}`}>
            {data.healthFactor === null ? "No debt" : data.healthFactor.toFixed(2)}
          </p>
          <Gauge hf={data.healthFactor} />
          <dl className="mt-4 grid grid-cols-3 gap-4 border-t hairline pt-4 text-sm">
            <div>
              <dt className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">Collateral</dt>
              <dd className="mt-1 font-mono tabular-nums">${Number(data.collateralUsd).toFixed(2)}</dd>
            </div>
            <div>
              <dt className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">Debt</dt>
              <dd className="mt-1 font-mono tabular-nums">${Number(data.debtUsd).toFixed(2)}</dd>
            </div>
            <div>
              <dt className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">Account</dt>
              <dd className="mt-1 font-mono">
                {data.account.slice(0, 6)}…{data.account.slice(-4)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        !error && <p className="mt-3 text-sm text-foreground/50">Reading the chain…</p>
      )}
      {error && <p className="mt-3 text-sm text-seal">{error}</p>}
    </div>
  );
}
