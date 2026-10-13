import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const OWN_API = /^https?:\/\/(localhost|127\.0\.0\.1):3000\b/;

/** Base URL of the real Themis server, or null to use the built-in stand-in (lib/fake-themis.ts). */
export function themisBase(): string | null {
  const url = process.env.THEMIS_URL?.trim();
  if (!url || OWN_API.test(url)) return null;
  return url.replace(/\/$/, "");
}

function token(role: "agent" | "owner"): string | undefined {
  const fromEnv = role === "owner" ? process.env.THEMIS_OWNER_TOKEN : process.env.THEMIS_AGENT_TOKEN;
  if (fromEnv) return fromEnv;
  const file = resolve(process.cwd(), "../../packages/themis/.local/api-credentials.json");
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8"))[`${role}Token`] as string) : undefined;
  } catch {
    return undefined;
  }
}

export async function themisFetch(base: string, path: string, init: { method?: string; body?: unknown; idempotencyKey?: string; as?: "agent" | "owner" } = {}) {
  // The owner token only ever leaves this server process toward Themis; it is never sent to the browser.
  const bearer = token(init.as ?? "agent");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return Response.json({ error: `Themis is not reachable at ${base}. Is the server running?` }, { status: 502 });
  }
  const body = await res.json().catch(() => ({ error: `Themis returned ${res.status} with a non-JSON body` }));
  return Response.json(body, { status: res.status });
}
