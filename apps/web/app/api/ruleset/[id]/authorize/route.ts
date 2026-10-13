import { themisBase, themisFetch } from "@/lib/themis";

// Owner step 2: hand Themis the Ledger's signatures. They are useless to anyone but the prepared operation.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const base = themisBase();
  if (!base) return Response.json({ error: "Ledger approval needs the real Themis server (set THEMIS_URL)." }, { status: 501 });
  if (!/^[0-9a-f]{64}$/.test(id)) return Response.json({ error: "Unknown ruleset." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { signatures?: unknown } | null;
  if (!body || typeof body.signatures !== "object" || body.signatures === null) {
    return Response.json({ status: "rejected", failed: ["invalid_signatures"] }, { status: 400 });
  }
  return themisFetch(base, `/ruleset/${id}/authorize`, { method: "POST", body: { signatures: body.signatures }, as: "owner" });
}
