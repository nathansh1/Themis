// Minimal stdio MCP server exposing propose_ruleset and send_intent to Hermes.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr only.
import { createInterface } from "node:readline";
import { kernelAccount } from "./account.mjs";
import { TOOL_DEFS, callTool } from "./tools.mjs";

const ctx = {
  themisUrl: process.env.THEMIS_URL || "http://localhost:3000/api",
  account: kernelAccount(),
};

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const log = (line) => process.stderr.write(`[themis-mcp] ${line}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications, e.g. notifications/initialized

  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "themis", version: "0.1.0" },
        },
      });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({ id, result: { tools: TOOL_DEFS } });
    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      try {
        const result = await callTool(name, args ?? {}, ctx);
        log(`${name} -> ${JSON.stringify(result)}`);
        return send({ id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        log(`${name} failed: ${text}`);
        return send({ id, result: { isError: true, content: [{ type: "text", text }] } });
      }
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

log(`ready, Themis at ${ctx.themisUrl}`);
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg).catch((e) => log(`handler error: ${e}`));
});
