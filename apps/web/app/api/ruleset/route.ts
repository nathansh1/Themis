import { connection } from "next/server";
import { getRulesets, propose } from "@/lib/fake-themis";
import { themisBase, themisFetch } from "@/lib/themis";

// Newest first, pending proposals included (GET /rulesets). Proposals go from Hermes straight to Themis.
export async function GET() {
  await connection();
  const base = themisBase();
  if (!base) return Response.json(getRulesets());

  return themisFetch(base, "/rulesets");
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
