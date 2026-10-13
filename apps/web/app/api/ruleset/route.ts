import { connection } from "next/server";
import { getRulesets, propose } from "@/lib/fake-themis";
import { themisBase, themisFetch } from "@/lib/themis";

// Real Themis only exposes the active ruleset (GET /ruleset); proposals go from Hermes straight to Themis.
export async function GET() {
  await connection();
  const base = themisBase();
  if (!base) return Response.json(getRulesets());

  const res = await themisFetch(base, "/ruleset");
  if (!res.ok) return res;
  const active = await res.json();
  return Response.json(active ? [active] : []);
}

export async function POST(request: Request) {
  if (themisBase()) {
    return Response.json({ error: "Proposals go directly to the Themis server; this route is only the stand-in." }, { status: 404 });
  }
  const rules: unknown = await request.json().catch(() => null);
  if (!rules || typeof rules !== "object") {
    return Response.json({ status: "rejected", failed: ["invalid_ruleset"] }, { status: 400 });
  }
  return Response.json(propose(rules), { status: 202 });
}
