import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const agentDir = resolve(process.cwd(), "../../packages/agent");

type Msg = { role: "user" | "assistant"; content: string };

function parse(body: unknown): Msg[] | null {
  const raw = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const msgs = raw.slice(-20).map((m) => ({
    role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: String(m?.content ?? "").slice(0, 2000),
  }));
  return msgs[msgs.length - 1].role === "user" && msgs[msgs.length - 1].content.trim() ? msgs : null;
}

// Each message is a one-shot Hermes run, so earlier turns are replayed in the prompt.
function prompt(msgs: Msg[]) {
  if (msgs.length === 1) return msgs[0].content;
  const history = msgs
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "User" : "Hermes"}: ${m.content}`)
    .join("\n");
  return `Conversation so far:\n${history}\n\nUser: ${msgs[msgs.length - 1].content}`;
}

export async function POST(request: Request) {
  const msgs = parse(await request.json().catch(() => null));
  if (!msgs) return Response.json({ error: "Send {messages:[...]} ending with a user message." }, { status: 400 });

  try {
    const { stdout } = await run(process.execPath, ["src/ask.mjs", "--say", prompt(msgs), "--json"], {
      cwd: agentDir,
      env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH ?? ""}` },
      timeout: 120_000,
    });
    const { summary } = JSON.parse(stdout) as { summary: string };
    return Response.json({ reply: summary || "(Hermes returned no text.)" });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return Response.json({ error: (err.stderr || err.message || String(e)).trim().slice(0, 600) }, { status: 500 });
  }
}
