import { decide, record } from "@/lib/fake-themis";

export async function POST(request: Request) {
  const intent: unknown = await request.json().catch(() => null);
  const result = decide(intent);
  record(intent, result);
  return Response.json(result);
}
