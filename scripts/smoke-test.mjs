// End-to-end smoke test: spawns the MCP server over stdio (exactly how Claude
// Code / Codex launch it) and exercises every tool.
//
//   node scripts/smoke-test.mjs
//
// Writes a couple of demo rows into data/synapse.db (gitignored). Delete the
// data/ folder to reset to an empty store.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");

const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
const client = new Client({ name: "smoke-test", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("Tools registered:", tools.map((t) => t.name).join(", "));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content[0].text;
};

console.log("\n--- write_handoff (Claude Code finishes work) ---");
console.log(await call("write_handoff", {
  task: "smoke",
  summary: "Implemented the store and MCP tools.",
  context: "Files: src/store.js, src/tools.js, src/server.js. Next: wire up Codex and test a real handoff.",
  from_agent: "claude-code",
}));

console.log("\n--- read_handoff (Codex picks it up) ---");
console.log(await call("read_handoff", { task: "smoke", as_agent: "codex" }));

console.log("\n--- remember / recall (shared scratchpad) ---");
await call("remember", { key: "project.goal", value: "no-copy-paste handoff between agents", agent: "claude-code" });
console.log(await call("recall", {}));

console.log("\n--- list_handoffs ---");
console.log(await call("list_handoffs", {}));

await client.close();
console.log("\nSMOKE TEST PASSED ✓");
