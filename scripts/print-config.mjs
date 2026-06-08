// Prints ready-to-paste MCP config for connecting any agent to this server.
// Any MCP-capable agent works — they all just launch the same command.
//
//   node scripts/print-config.mjs   (or: npm run config)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");
const jsonPath = serverPath.replace(/\\/g, "\\\\"); // escaped for JSON
const tomlPath = serverPath.replace(/\\/g, "\\"); // single-quoted TOML = literal

console.log(`Server entry: ${serverPath}\n`);

console.log("── Claude Code ──  (run once, user scope → available everywhere)");
console.log(`claude mcp add agent-synapse --scope user -- node ${serverPath}\n`);

console.log("── Codex CLI ──  (~/.codex/config.toml)");
console.log(`[mcp_servers.agent-synapse]
command = "node"
args = ['${tomlPath}']
startup_timeout_sec = 60\n`);

console.log("── Cursor / Cline / Windsurf / Zed / generic MCP ──  (mcp.json)");
console.log(
  JSON.stringify(
    { mcpServers: { "agent-synapse": { command: "node", args: [serverPath] } } },
    null,
    2
  ) + "\n"
);

console.log("── Gemini CLI ──  (~/.gemini/settings.json, mcpServers block)");
console.log(
  JSON.stringify({ "agent-synapse": { command: "node", args: [serverPath] } }, null, 2)
);

console.log(
  "\nTip: to force a project name for an agent, add an env var to its config:\n" +
    "  Codex:   [mcp_servers.agent-synapse.env]  AGENT_SYNAPSE_PROJECT = \"my-project\"\n" +
    '  JSON:    "env": { "AGENT_SYNAPSE_PROJECT": "my-project" }'
);
