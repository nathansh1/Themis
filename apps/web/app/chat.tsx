"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTION = "Protect my position overnight, max $1,500";

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, busy]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setMessages([...next, { role: "assistant", content: body.reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="hairline flex h-72 flex-col gap-4 overflow-y-auto border p-4">
        {messages.length === 0 && !busy && (
          <div className="flex flex-col items-start gap-3 text-sm text-foreground/60">
            <p>Tell Hermes how to guard your position. It will propose a ruleset for you to approve on the Ledger.</p>
            <button type="button" onClick={() => setInput(SUGGESTION)} className="btn btn-line">
              {SUGGESTION}
            </button>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}>
            <span className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">
              {m.role === "user" ? "You" : "Hermes"}
            </span>
            <p
              className={`max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed ${
                m.role === "user" ? "hairline border px-3 py-2" : ""
              }`}
            >
              {m.content}
            </p>
          </div>
        ))}
        {busy && (
          <div className="flex flex-col items-start gap-1">
            <span className="font-display text-[10px] uppercase tracking-[0.18em] text-foreground/50">Hermes</span>
            <p className="text-sm text-foreground/50">Thinking…</p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="break-words text-sm text-seal">{error}</p>}

      <form onSubmit={send} className="flex gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder="Tell Hermes how to protect your position"
          className="hairline min-w-0 flex-1 border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-foreground/35 focus:border-foreground disabled:opacity-50"
        />
        <button type="submit" disabled={busy || !input.trim()} className="btn btn-solid">
          Send
        </button>
      </form>
    </div>
  );
}
