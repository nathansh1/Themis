"use client";

import type { Ruleset } from "@themis/shared";
import type { PendingRuleset } from "@/lib/fake-themis";
import { usePoll } from "@/lib/use-poll";

const when = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 border-t hairline py-3 text-sm">
      <dt className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function RulesetReview() {
  const { data, error } = usePoll<PendingRuleset[]>("/api/ruleset", 3000);
  const latest = data?.at(-1);
  const r = latest?.ruleset as Ruleset | undefined;

  if (error) return <p className="text-sm text-seal">{error}</p>;
  if (!latest || !r) {
    return (
      <p className="text-sm text-foreground/50">
        No ruleset proposed yet. Tell Hermes how to protect the position and it will appear here.
      </p>
    );
  }

  const perAction = Number(r.maxPerAction);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="stamp inline-block border-2 border-warn px-2 py-1 font-display text-xs font-bold uppercase tracking-[0.2em] text-warn">
          Pending
        </span>
        <span className="font-display text-[11px] uppercase tracking-[0.18em] text-foreground/60">
          Awaiting Ledger approval
        </span>
        {data && data.length > 1 && (
          <span className="ml-auto text-xs text-foreground/40">Proposal {latest.id} of {data.length}</span>
        )}
      </div>
      <dl>
        <Row label="Acts when">Health factor falls below <strong>{r.trigger.healthFactorBelow}</strong></Row>
        <Row label="May do">
          {r.allow.map((a) => `${a.protocol === "aave-v3" ? "Aave V3" : a.protocol} · ${a.action} · ${a.asset}`).join("; ")}
        </Row>
        <Row label="Per action">Up to <strong className="font-mono">{r.maxPerAction} USDC</strong></Row>
        <Row label="Total">
          At most <strong>{r.maxActions}</strong> actions, <strong className="font-mono">{(perAction * r.maxActions).toLocaleString()} USDC</strong> in all
        </Row>
        <Row label="Window">{when(r.window.start)} to {when(r.window.end)}</Row>
        <Row label="Account">
          <code className="break-all font-mono text-xs">{r.account}</code>
        </Row>
      </dl>
    </div>
  );
}
