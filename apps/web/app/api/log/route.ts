import { connection } from "next/server";
import { getLog } from "@/lib/fake-themis";

export async function GET() {
  await connection();
  return Response.json(getLog());
}
