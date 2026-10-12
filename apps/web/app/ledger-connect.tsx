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
      <p className="text-sm text-red-600">
        WebHID is not available in this browser. Use Chrome or Edge.
      </p>
    );
  }

  const matches =
    signed && address && signed.recovered.toLowerCase() === address.toLowerCase();

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={connect}
          disabled={busy}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {address ? "Reconnect Ledger" : "Connect Ledger"}
        </button>
        {address && (
          <button
            onClick={signTest}
            disabled={busy}
            className="rounded-full border border-foreground/20 px-5 py-2 text-sm font-medium disabled:opacity-50"
          >
            Sign test message
          </button>
        )}
        <span className="text-sm text-foreground/60">{status}</span>
      </div>

      {address && (
        <p className="text-sm">
          Ledger address: <code className="font-mono">{address}</code>
        </p>
      )}

      {signed && (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            Signed: <code className="font-mono">{signed.message}</code>
          </p>
          <p className="break-all">
            Signature: <code className="font-mono">{signed.signature}</code>
          </p>
          <p>
            Recovered signer matches Ledger address:{" "}
            <strong className={matches ? "text-green-600" : "text-red-600"}>
              {matches ? "yes" : "NO"}
            </strong>
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
