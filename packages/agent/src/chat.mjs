// Opens Hermes's own chat (TUI) pointed at Venice, with propose_ruleset and send_intent attached.
//   node src/chat.mjs                 launch the chat
//   node src/chat.mjs --print-config  write and show the generated Hermes profile config, then exit
import { loadConfig } from "./config.mjs";
import { PROFILE_DIR, hermesConfigYaml, launchChat, prepare } from "./hermes-agent.mjs";

const cfg = loadConfig();
if (process.argv.includes("--print-config")) {
  prepare(cfg.hermes);
  console.log(`# ${PROFILE_DIR}/config.yaml\n${hermesConfigYaml(cfg.hermes)}`);
} else {
  launchChat(cfg.hermes);
}
