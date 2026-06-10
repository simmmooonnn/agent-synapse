// End-to-end test of TEAM MODE: the remote-server + the remote backend client.
//
//   node scripts/team-smoke-test.mjs
//
// Spins up server/remote-server.js on a throwaway data dir + test tokens, then:
//   - drives it as "alice" via the REAL client (src/backends/remote.js)
//   - drives it as "bob" (same workspace) via raw requests -> sees alice's data
//   - drives it as a DIFFERENT workspace -> sees nothing (isolation)
//   - checks auth (bad/no token -> 401) and unknown routes (-> 404)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const SERVER_DATA = mkdtempSync(join(tmpdir(), "agent-synapse-team-"));

// Configure + start the server in-process (it listens on import).
process.env.AGENT_SYNAPSE_PORT = String(PORT);
process.env.AGENT_SYNAPSE_SERVER_DATA = SERVER_DATA;
process.env.AGENT_SYNAPSE_TOKENS = "tok_alice:alice,tok_bob:bob";
await import(pathToFileURL(join(repo, "server", "remote-server.js")).href);

let failures = 0;
const check = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ FAIL ") + msg); if (!cond) failures++; };

async function api(path, body, { token, workspace, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  if (workspace) headers["X-Workspace"] = workspace;
  const res = await fetch(BASE + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waitHealth(ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

await waitHealth();

console.log("--- health + auth mode ---");
const health = await api("/health", null, { method: "GET" });
check(health.status === 200 && health.json.mode === "auth", "health reports auth mode");

console.log("\n--- alice writes via the REAL remote client (workspace team1) ---");
process.env.AGENT_SYNAPSE_REMOTE_URL = BASE;
process.env.AGENT_SYNAPSE_TOKEN = "tok_alice";
process.env.AGENT_SYNAPSE_WORKSPACE = "team1";
const remote = await import(pathToFileURL(join(repo, "src", "backends", "remote.js")).href);
const written = await remote.writeHandoff({ task: "shared task", summary: "from alice", context: "ctx", project: "projA", from_agent: "alice" });
check(written && Number.isInteger(written.id), "remote client writeHandoff returns an id");
await remote.remember({ key: "team.fact", value: "hello team", project: null });
const aliceList = await remote.listHandoffs({ project: "projA" });
check(aliceList.some((h) => h.task === "shared task"), "alice reads back her own handoff via the client");

console.log("\n--- bob (same workspace) sees alice's data ---");
const bobList = await api("/handoffs/list", { project: "projA" }, { token: "tok_bob", workspace: "team1" });
check(bobList.json.handoffs.some((h) => h.task === "shared task"), "bob lists the handoff alice wrote (shared store)");
const bobMem = await api("/memory/get", { key: "team.fact" }, { token: "tok_bob", workspace: "team1" });
check(bobMem.json.entry && bobMem.json.entry.value === "hello team", "bob recalls the memory alice wrote");

console.log("\n--- a different workspace is isolated ---");
const otherList = await api("/handoffs/list", {}, { token: "tok_bob", workspace: "team2" });
check(Array.isArray(otherList.json.handoffs) && otherList.json.handoffs.length === 0, "team2 sees NO handoffs from team1");
const otherMem = await api("/memory/get", { key: "team.fact" }, { token: "tok_bob", workspace: "team2" });
check(otherMem.json.entry == null, "team2 does NOT see team1's memory");

console.log("\n--- status / stats / thread / search round-trip ---");
const id = bobList.json.handoffs.find((h) => h.task === "shared task").id;
const st = await api("/handoffs/set-status", { id, status: "done", by: "bob" }, { token: "tok_bob", workspace: "team1" });
check(st.json.ok === true, "set-status done");
const stats = await api("/handoffs/stats", {}, { token: "tok_bob", workspace: "team1" });
check(stats.json.stats.some((s) => s.project === "projA" && Number(s.done) === 1), "stats reflects the done handoff");
const reply = await api("/handoffs/write", { task: "re: shared task", summary: "bob replies", project: "projA", reply_to: id }, { token: "tok_bob", workspace: "team1" });
const thread = await api("/handoffs/thread", { id: reply.json.id }, { token: "tok_bob", workspace: "team1" });
check(thread.json.handoffs.length === 2 && thread.json.handoffs[0].id === id, "thread returns the chain root-first");
const search = await api("/handoffs/search", { query: "replies", project: "projA" }, { token: "tok_bob", workspace: "team1" });
check(search.json.handoffs.some((h) => h.task === "re: shared task"), "search finds bob's reply");

console.log("\n--- auth is enforced ---");
const badTok = await api("/handoffs/list", {}, { token: "nope", workspace: "team1" });
check(badTok.status === 401, "bad token -> 401");
const noTok = await api("/handoffs/list", {}, { workspace: "team1" });
check(noTok.status === 401, "missing token -> 401");
const notFound = await api("/nope/nope", {}, { token: "tok_bob", workspace: "team1" });
check(notFound.status === 404, "unknown route -> 404");

try { rmSync(SERVER_DATA, { recursive: true, force: true }); } catch { /* DBs still open; OS temp cleans up */ }
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED ✓" : failures + " CHECK(S) FAILED ✗"));
process.exit(failures === 0 ? 0 : 1);
