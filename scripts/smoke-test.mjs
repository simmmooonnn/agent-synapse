// End-to-end test that spawns the MCP server over stdio (exactly how Claude
// Code / Codex launch it) and verifies PROJECT ISOLATION (v1):
//   - handoffs written in project A are not visible in project B
//   - read/list default to the current project
//   - all_projects:true sees everything
//   - the memory scratchpad stays GLOBAL across projects
//
//   node scripts/smoke-test.mjs
//
// Uses unique project tags so it does not collide with your real data.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");

async function session(project) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: { ...process.env, AGENT_SYNAPSE_PROJECT: project },
  });
  const client = new Client({ name: "smoke", version: "0.1.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
  return { client, call };
}

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ FAIL ") + msg);
  if (!cond) failures++;
};

const A = "smoke-projA";
const B = "smoke-projB";

const a = await session(A);
const b = await session(B);

console.log("Tools:", (await a.client.listTools()).tools.map((t) => t.name).join(", "));

console.log("\n--- A and B each write a handoff ---");
console.log("  " + (await a.call("write_handoff", { task: "featureA", summary: "Did work in project A.", from_agent: "claude-code" })));
console.log("  " + (await b.call("write_handoff", { task: "featureB", summary: "Did work in project B.", from_agent: "claude-code" })));

console.log("\n--- isolation ---");
const aList = await a.call("list_handoffs");
const bList = await b.call("list_handoffs");
check(aList.includes("featureA"), "A sees its own handoff");
check(!aList.includes("featureB"), "A does NOT see B's handoff");
check(bList.includes("featureB"), "B sees its own handoff");
check(!bList.includes("featureA"), "B does NOT see A's handoff");

console.log("\n--- read_handoff defaults to current project ---");
const aRead = await a.call("read_handoff", { as_agent: "codex" });
check(aRead.includes("featureA") && !aRead.includes("featureB"), "A reads its own latest handoff");

console.log("\n--- all_projects:true sees both ---");
const all = await a.call("list_handoffs", { all_projects: true });
check(all.includes("featureA") && all.includes("featureB"), "all_projects shows A and B");

console.log("\n--- memory stays global across projects ---");
await a.call("remember", { key: "smoke.shared", value: "visible everywhere", agent: "claude-code" });
const bRecall = await b.call("recall", { key: "smoke.shared" });
check(bRecall.includes("visible everywhere"), "B recalls memory written by A (global)");

await a.client.close();
await b.client.close();

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED ✓" : `${failures} CHECK(S) FAILED ✗`));
process.exit(failures === 0 ? 0 : 1);
