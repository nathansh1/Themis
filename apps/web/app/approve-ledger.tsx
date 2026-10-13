"use client";

import { useState } from "react";
import type { Ruleset } from "@themis/shared";
import { getLedgerAddress, signLedgerRaw, toHexSignature, typedDataDigest, type WireTypedData } from "@/lib/ledger";

type SignRequest =
  | { id: string; kind: "typedData"; typedData: WireTypedData }
  | { id: string; kind: "message"; raw: `0x${string}` };

const REFUSALS: Record<string, string> = {
  existing_session_active:
    "A previous session is still running on-chain. Its allowance is shared with a new one, so wait for it to end first.",
  window_closed: "This ruleset's window has already ended. Ask Hermes for a new one.",
  account_busy: "Another operation is still settling. Try again in a moment.",
  ruleset_not_pending: "This ruleset is no longer waiting for approval.",
  chain_unavailable: "Sepolia is unreachable right now.",
  authorization_unavailable: "Themis could not assemble the approval. Check the server log.",
  authorization_changed: "The account changed while you were signing. Start again.",
  owner_approval_reverted: "The approval transaction reverted on-chain. Nothing was authorized.",
  interrupted_before_submission: "The approval was interrupted before it was sent. Nothing was authorized.",
};
const explain = (failed?: string[], fallback = "Approval failed.") =>
  failed?.length ? failed.map((code) => REFUSALS[code] ?? code).join(" ") : fallback;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export default function ApproveLedger({ id, rules }: { id: string; rules: Ruleset }) {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the device should be showing right now, so the owner can compare before confirming.
  const [check, setCheck] = useState<{ label: string; rows: [string, string][] } | null>(null);

  const allowance = (Number(rules.maxPerAction) * rules.maxActions).toLocaleString();

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      setStep("Connecting to your Ledger. Choose it in the browser prompt.");
      const ledger = await getLedgerAddress((i) => setStep(`Waiting on Ledger: ${i}`));

      setStep("Asking Themis what needs your signature");
      const prepared = await post(`/api/ruleset/${id}/prepare`);
      if (!prepared.ok) throw new Error(explain(prepared.json.failed, prepared.json.error));
      const { owner, requests } = prepared.json as { owner: `0x${string}`; requests: SignRequest[] };
      if (ledger.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(`This Ledger (${ledger}) does not own the account. Expected ${owner}.`);
      }

      const signatures: Record<string, string> = {};
      for (const [i, request] of requests.entries()) {
        const label = request.kind === "typedData" ? "the session permission" : "the allowance";
        const onInteraction = (what: string) => setStep(`Approve ${label} on your Ledger (${i + 1} of ${requests.length}): ${what}`);
        setStep(`Approve ${label} on your Ledger (${i + 1} of ${requests.length})`);
        // Both prompts are 32-byte messages on the device. For the permission, check the digest against its contents first.
        const message = request.kind === "typedData" ? typedDataDigest(request.typedData) : request.raw;
        if (request.kind === "typedData" && message !== request.id) {
          throw new Error("Themis asked to sign a permission whose contents do not match its digest. Nothing was signed.");
        }
        setCheck({ label: `Your Ledger shows ${label}'s 32-byte hash as the message. Confirm only if it matches:`, rows: [["Message", message]] });
        const signature = await signLedgerRaw(message, onInteraction);
        signatures[request.id] = toHexSignature(signature);
      }

      setCheck(null);
      setStep("Sending your approval to Themis");
      const sent = await post(`/api/ruleset/${id}/authorize`, { signatures });
      if (!sent.ok && sent.status !== 202) throw new Error(explain(sent.json.failed, sent.json.error));
      if (sent.json.status === "rejected") throw new Error(explain(sent.json.failed));

      setStep("Waiting for the approval to land on-chain");
      for (let waited = 0; waited < 180_000; waited += 3000) {
        const list = await fetch("/api/ruleset", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
        if (Array.isArray(list) && list.some((g: { id: string; status: string }) => g.id === id && g.status === "active")) {
          setStep(null);
          return;
        }
        await sleep(3000);
      }
      throw new Error("The approval has not confirmed yet. Check the Docket and Etherscan before trying again.");
    } catch (e) {
      setStep(null);
      setCheck(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 flex flex-col gap-3 border-t hairline pt-5">
      <p className="text-sm text-foreground/70">
        Approving signs two things on your Ledger: the session key&apos;s permission, then one on-chain allowance of{" "}
        <strong className="font-mono">{allowance} USDC</strong> to the Aave pool. Nothing else can be spent.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={approve} disabled={busy} className="btn btn-solid">
          {busy ? "Waiting for Ledger…" : "Approve on Ledger"}
        </button>
        {step && <span className="font-display text-[11px] uppercase tracking-[0.18em] text-foreground/60">{step}</span>}
      </div>
      {check && (
        <div className="flex flex-col gap-2 border hairline p-3 text-sm">
          <p className="text-foreground/70">{check.label}</p>
          {check.rows.map(([name, value]) => (
            <p key={name} className="break-all">
              <span className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">{name} </span>
              <code className="font-mono text-xs">{value}</code>
            </p>
          ))}
          <p className="text-xs text-foreground/50">
            If the Ledger refuses to show the message, enable Blind signing in the Ethereum app&apos;s settings, then click Approve again.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-seal">{error}</p>}
    </div>
  );
}
