import { decide, record } from "@/lib/fake-themis";
import { themisBase, themisFetch } from "@/lib/themis";

export async function POST(request: Request) {
  const intent: unknown = await request.json().catch(() => null);
  const base = themisBase();
  if (base) return themisFetch(base, "/intent", { method: "POST", body: intent, idempotencyKey: `web-${crypto.randomUUID()}` });

  const result = decide(intent);
  record(intent, result);
  return Response.json(result);
}
