import { connection } from "next/server";
import { getLog } from "@/lib/fake-themis";
import { themisBase, themisFetch } from "@/lib/themis";

export async function GET() {
  await connection();
  const base = themisBase();
  if (!base) return Response.json(getLog());

  const res = await themisFetch(base, "/log?limit=100");
  if (!res.ok) return res;
  const { entries } = (await res.json()) as { entries: unknown[] };
  return Response.json(entries);
}
