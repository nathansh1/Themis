import { connection } from "next/server";
import { readHealth } from "@/lib/aave";

export async function GET() {
  await connection();
  try {
    return Response.json(await readHealth());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
