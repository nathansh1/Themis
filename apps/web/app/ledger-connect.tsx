"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { recoverMessageAddress } from "viem";
import {
  getLedgerAddress,
  preloadLedger,
  signLedgerMessage,
} from "@/lib/ledger";

type Signed = { message: string; signature: `0x${string}`; recovered: `0x${string}` };

export default function LedgerConnect() {
  const supported = useSyncExternalStore(
    () => () => {},
    () => "hid" in navigator,
    () => true,
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Not connected");
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    preloadLedger();
  }, []);

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    guarded(async () => {
      setStatus("Choose your Ledger in the browser prompt");
      const addr = await getLedgerAddress((i) => setStatus(`Waiting on Ledger: ${i}`));
      setAddress(addr);
      setStatus("Connected");
    });

  const signTest = () =>
    guarded(async () => {
      const message = `Themis connect test ${new Date().toISOString()}`;
      setSigned(null);
      const sig = await signLedgerMessage(message, (i) => setStatus(`Waiting on Ledger: ${i}`));
      const v = sig.v.toString(16).padStart(2, "0");
      const signature = `0x${sig.r.slice(2)}${sig.s.slice(2)}${v}` as const;
      const recovered = await recoverMessageAddress({ message, signature });
      setSigned({ message, signature, recovered });
      setStatus("Connected");
    });

  if (!supported) {
    return (
      <p className="text-sm text-seal">
        WebHID is not available in this browser. Use Chrome or Edge.
      </p>
    );
  }

  const matches =
    signed && address && signed.recovered.toLowerCase() === address.toLowerCase();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${address ? "bg-ok" : "bg-foreground/30"}`} />
        <span className="font-display text-[11px] uppercase tracking-[0.18em] text-foreground/60">{status}</span>
      </div>

      <div className="flex flex-wrap gap-3">
        <button onClick={connect} disabled={busy} className="btn btn-solid">
          {address ? "Reconnect Ledger" : "Connect Ledger"}
        </button>
        {address && (
          <button onClick={signTest} disabled={busy} className="btn btn-line">
            Sign test message
          </button>
        )}
      </div>

      {address && (
        <div>
          <p className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">Ledger address</p>
          <p className="mt-1 break-all font-mono text-sm">{address}</p>
        </div>
      )}

      {signed && (
        <div className="flex flex-col gap-2 border-t hairline pt-4 text-sm">
          <p>
            <span className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">Signed </span>
            <code className="font-mono">{signed.message}</code>
          </p>
          <p className="break-all">
            <span className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">Signature </span>
            <code className="font-mono text-xs">{signed.signature}</code>
          </p>
          <p>
            <span className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">
              Recovered signer matches Ledger{" "}
            </span>
            <strong className={matches ? "text-ok" : "text-seal"}>{matches ? "Yes" : "No"}</strong>
          </p>
        </div>
      )}

      {error && <p className="text-sm text-seal">{error}</p>}
    </div>
  );
}
