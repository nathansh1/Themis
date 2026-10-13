// Runs the real Hermes Agent (Nous Research) against Venice, with the Themis MCP server attached.
// Everything lives in a dedicated Hermes profile ("themis"), so the user's default profile is untouched.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONA } from "./hermes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = resolve(here, "mcp-server.mjs");
export const PROFILE = "themis";
export const PROFILE_DIR = resolve(process.env.HERMES_HOME || resolve(homedir(), ".hermes"), "profiles", PROFILE);

const q = (s) => JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars

// Built-in toolsets switched off so the agent's only way to act is Themis (the demo claim is "one door").
const LOCKED_TOOLSETS = [
  "terminal", "file", "code_execution", "computer_use", "browser", "web",
  "delegation", "cronjob", "connections", "image_gen", "vision", "tts", "skills",
];

/** The config blocks we own (model, mcp_servers, tools); everything else in the profile's config.yaml is left as Hermes wrote it. */
export function hermesConfigYaml(hermes) {
  const env = [`      THEMIS_URL: ${q(hermes.themisUrl)}`];
  if (hermes.account) env.push(`      KERNEL_ADDRESS: ${q(hermes.account)}`);
  return `model:
  default: ${q(hermes.model)}
  provider: custom
  base_url: ${q(hermes.baseUrl)}
  key_env: VENICE_API_KEY
mcp_servers:
  themis:
    command: ${q(process.execPath)}
    args: [${q(MCP_SERVER)}]
    env:
${env.join("\n")}
    timeout_seconds: 120
tools:
  tool_search:
    enabled: "off"
`;
}

function stripTopLevel(text, keys) {
  let skipping = false;
  return text
    .split("\n")
    .filter((line) => {
      const top = /^([A-Za-z_][\w-]*):/.exec(line);
      if (top) skipping = keys.includes(top[1]);
      return !skipping;
    })
    .join("\n");
}

const bin = () => process.env.HERMES_BIN || "hermes";
const extraArgs = () => (process.env.HERMES_EXTRA_ARGS ? process.env.HERMES_EXTRA_ARGS.split(/\s+/).filter(Boolean) : []);

function notInstalled() {
  return new Error(
    `Could not run "${bin()}". Install Hermes Agent (curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash), ` +
      "or set AGENT_MODE=direct to use the plain Venice fallback.",
  );
}

/** Create the profile if needed, then write its config and persona. Returns the env to run Hermes with. */
export function prepare(hermes) {
  if (!existsSync(PROFILE_DIR)) {
    try {
      execFileSync(bin(), ["profile", "create", PROFILE, "--no-alias", "--no-skills"], { stdio: "ignore" });
      execFileSync(bin(), ["-p", PROFILE, "tools", "disable", ...LOCKED_TOOLSETS], { stdio: "ignore" });
    } catch (e) {
      throw e.code === "ENOENT" ? notInstalled() : new Error(`Could not create the Hermes profile "${PROFILE}": ${e.message}`);
    }
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  const configPath = resolve(PROFILE_DIR, "config.yaml");
  const rest = existsSync(configPath) ? stripTopLevel(readFileSync(configPath, "utf8"), ["model", "mcp_servers", "tools"]).trim() : "";
  writeFileSync(configPath, hermesConfigYaml(hermes) + (rest ? `${rest}\n` : ""));
  writeFileSync(resolve(PROFILE_DIR, "SOUL.md"), PERSONA + "\n");
  return { ...process.env, VENICE_API_KEY: hermes.apiKey };
}

/** Interactive chat: Hermes's own TUI is the chat window. */
export function launchChat(hermes) {
  const env = prepare(hermes);
  const child = spawn(bin(), ["-p", PROFILE, "--tui", ...extraArgs()], { env, stdio: "inherit" });
  child.on("error", (e) => {
    console.error(e.code === "ENOENT" ? notInstalled().message : e);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/** One-shot wake for the watcher: one prompt in, final text out. */
export function runHermesAgent(prompt, hermes) {
  const env = prepare(hermes);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin(), ["-p", PROFILE, "-z", prompt, ...extraArgs()], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Hermes timed out after 180s"));
    }, 180_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? notInstalled() : e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out.trim());
      else reject(new Error(`Hermes exited with ${code}: ${(err || out).trim().slice(0, 500)}`));
    });
  });
}
