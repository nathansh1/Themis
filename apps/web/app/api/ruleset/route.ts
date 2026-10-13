import { connection } from "next/server";
import { getRulesets, propose } from "@/lib/fake-themis";

export async function POST(request: Request) {
  const ruleset: unknown = await request.json().catch(() => null);
  if (!ruleset || typeof ruleset !== "object") {
    return Response.json({ status: "rejected", failed: ["body is not a ruleset object"] }, { status: 400 });
  }
  return Response.json(propose(ruleset));
}

export async function GET() {
  await connection();
  return Response.json(getRulesets());
}
