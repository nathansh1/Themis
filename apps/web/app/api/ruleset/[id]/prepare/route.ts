import { themisBase, themisFetch } from "@/lib/themis";

// Owner step 1: ask Themis what the Ledger must sign. The owner token stays on this server.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const base = themisBase();
  if (!base) return Response.json({ error: "Ledger approval needs the real Themis server (set THEMIS_URL)." }, { status: 501 });
  if (!/^[0-9a-f]{64}$/.test(id)) return Response.json({ error: "Unknown ruleset." }, { status: 404 });
  return themisFetch(base, `/ruleset/${id}/prepare`, { method: "POST", as: "owner" });
}
