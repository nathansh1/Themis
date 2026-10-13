// The Kernel account Themis protects. Same precedence as Themis itself, plus the older KERNEL_ADDRESS name.
import { existsSync, readFileSync } from "node:fs";

const proof = new URL("../../themis/a1-state.json", import.meta.url);

export function kernelAccount() {
  const fromEnv = process.env.KERNEL_ACCOUNT_ADDRESS || process.env.KERNEL_ADDRESS;
  if (fromEnv) return fromEnv;
  try {
    return existsSync(proof) ? JSON.parse(readFileSync(proof, "utf8")).account : undefined;
  } catch {
    return undefined;
  }
}
