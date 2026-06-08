// One-command installer: auto-connect the agents on THIS machine to this
// agent-synapse checkout.
//
//   npm run connect
//
// - Claude Code: registers the MCP server at user scope (via the claude CLI).
// - Codex CLI:   appends an [mcp_servers.agent-synapse] block to config.toml.
// - Other agents: prints where to get their snippet (npm run config).
//
// Idempotent: skips anything already configured. Each person runs this on their
// OWN machine after cloning — it writes paths/configs local to that machine, and
// each machine keeps its own data/synapse.db (no cross-machine sharing yet — that
// is team mode / v3).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: true });
}

function installClaude() {
  try {
    run("claude --version");
  } catch {
    return "Claude Code  — claude CLI not found, skipped (run `npm run config` for the snippet).";
  }
  try {
    if (run("claude mcp list").includes("agent-synapse")) return "Claude Code  — already configured ✓";
  } catch {
    /* mcp list may fail on some versions; fall through to add */
  }
  try {
    run(`claude mcp add agent-synapse --scope user -- node "${serverPath}"`);
    return "Claude Code  — configured ✓ (restart to load)";
  } catch {
    return "Claude Code  — could not auto-configure; run `npm run config` for the one-liner.";
  }
}

function installCodex() {
  const cfg = join(homedir(), ".codex", "config.toml");
  if (!existsSync(cfg)) return "Codex CLI    — ~/.codex/config.toml not found, skipped.";
  const toml = readFileSync(cfg, "utf8");
  if (toml.includes("[mcp_servers.agent-synapse]")) return "Codex CLI    — already configured ✓";
  const block = `\n[mcp_servers.agent-synapse]\ncommand = "node"\nargs = ['${serverPath}']\nstartup_timeout_sec = 60\n`;
  writeFileSync(cfg, toml.replace(/\s*$/, "\n") + block);
  return "Codex CLI    — configured ✓ (restart to load)";
}

console.log(`Connecting agents to: ${serverPath}\n`);
console.log("  " + installClaude());
console.log("  " + installCodex());
console.log("\n  Other MCP agents (Cursor, Cline, Windsurf, Zed, Gemini): `npm run config` for ready snippets.");
console.log("\nDone. Restart any agent that was just configured so it loads the tools.");
