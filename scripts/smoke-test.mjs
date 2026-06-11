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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");

// Run against a throwaway DB in the OS temp dir, NOT data/synapse.db, so the
// test never reads or mutates your real handoffs/memory. Cleaned up at the end.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-synapse-test-"));

async function session(project) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: { ...process.env, AGENT_SYNAPSE_PROJECT: project, AGENT_SYNAPSE_DATA: TEST_DATA_DIR },
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

console.log("\n--- read a specific handoff by id ---");
const wResp = await a.call("write_handoff", { task: "todelete", summary: "temporary handoff" });
const newId = parseInt(wResp.match(/#(\d+)/)[1], 10);
const byId = await a.call("read_handoff", { id: newId });
check(byId.includes("todelete"), `read_handoff by id #${newId} returns that handoff`);

console.log("\n--- delete a handoff by id ---");
const delResp = await a.call("delete_handoff", { id: newId });
check(delResp.includes("Deleted"), `delete_handoff removes #${newId}`);
const afterDel = await a.call("read_handoff", { id: newId });
check(afterDel.includes("No handoff with id"), "deleted handoff is gone");

console.log("\n--- memory stays global across projects ---");
await a.call("remember", { key: "smoke.shared", value: "visible everywhere", agent: "claude-code" });
const bRecall = await b.call("recall", { key: "smoke.shared" });
check(bRecall.includes("visible everywhere"), "B recalls memory written by A (global)");

console.log("\n--- project-scoped memory is isolated ---");
await a.call("remember", { key: "smoke.scoped", value: "only in A", this_project: true });
const aScoped = await a.call("recall", { key: "smoke.scoped", this_project: true });
check(aScoped.includes("only in A"), "A recalls its own project-scoped memory");
const bScoped = await b.call("recall", { key: "smoke.scoped", this_project: true });
check(bScoped.includes("Nothing stored"), "B does NOT see A's project-scoped memory");
const bGlobalMiss = await b.call("recall", { key: "smoke.scoped" });
check(bGlobalMiss.includes("Nothing stored"), "project-scoped memory is not visible as global");

console.log("\n--- search_handoffs finds by keyword ---");
const searchHit = await a.call("search_handoffs", { query: "featureA" });
check(searchHit.includes("featureA"), "search finds A's handoff by keyword");
const searchScoped = await a.call("search_handoffs", { query: "featureB" });
check(searchScoped.includes("No handoffs matching"), "search is project-scoped by default");
const searchAll = await a.call("search_handoffs", { query: "featureB", all_projects: true });
check(searchAll.includes("featureB"), "search all_projects:true finds B's handoff");

console.log("\n--- search_memory finds remembered facts ---");
const memSearch = await a.call("search_memory", { query: "visible everywhere" });
check(memSearch.includes("smoke.shared"), "search_memory finds a value substring");

console.log("\n--- threading: reply_to chains handoffs ---");
const root = await a.call("write_handoff", { task: "thread-root", summary: "first message" });
const rootId = parseInt(root.match(/#(\d+)/)[1], 10);
const reply = await a.call("write_handoff", { task: "thread-reply", summary: "second message", reply_to: rootId });
const replyId = parseInt(reply.match(/#(\d+)/)[1], 10);
check(reply.includes("reply to #" + rootId), "write_handoff records the reply link");
const threadRead = await a.call("read_handoff", { id: replyId, thread: true });
check(threadRead.includes("first message") && threadRead.includes("second message"), "read thread:true returns the whole chain");

console.log("\n--- status lifecycle: open -> acked -> done ---");
await a.call("set_handoff_status", { id: rootId, status: "acked", by: "codex" });
const acked = await a.call("read_handoff", { id: rootId });
check(acked.includes("Status: acked"), "status set to acked");
await a.call("set_handoff_status", { id: rootId, status: "done" });
const done = await a.call("read_handoff", { id: rootId });
check(done.includes("Status: done"), "status set to done");
const badStatus = await a.call("set_handoff_status", { id: 999999, status: "done" });
check(badStatus.includes("No handoff with id"), "status on missing id reports not found");

console.log("\n--- handoff_stats rolls up the current project ---");
const stat = await a.call("handoff_stats", { this_project: true });
check(stat.includes(A) && stat.includes("total"), "stats reports counts for project A");

console.log("\n--- cost tracking flows into stats ---");
await a.call("write_handoff", { task: "costly", summary: "expensive run", cost: 1.25 });
const costStat = await a.call("handoff_stats", { this_project: true });
check(costStat.includes("$1.25"), "reported cost shows up in handoff_stats");

console.log("\n--- recent_activity records what happened ---");
const act = await a.call("recent_activity", { this_project: true, limit: 50 });
check(act.includes("wrote handoff") && act.includes("featureA"), "activity logs the handoff write");
check(act.includes("set status") || act.includes("set status of") || act.includes("→ done"), "activity logs a status change");
check(act.includes("deleted handoff"), "activity logs the deletion");
const actByActor = await a.call("recent_activity", { this_project: true, actor: "codex" });
check(actByActor.includes("codex") && !actByActor.includes("someone"), "activity filters by actor");

await a.client.close();
await b.client.close();

// Remove the throwaway test DB.
rmSync(TEST_DATA_DIR, { recursive: true, force: true });

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED ✓" : `${failures} CHECK(S) FAILED ✗`));
process.exit(failures === 0 ? 0 : 1);
