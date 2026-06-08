// Quick CLI peek at recent handoffs and shared memory — no server needed.
//
//   node scripts/show-handoffs.mjs       (or: npm run handoffs)
//
// Reads directly from data/synapse.db, proving the data persists on disk
// independently of the MCP server or dashboard.

import * as store from "../src/store.js";

const rows = store.listHandoffs({ limit: 10 });

console.log("=== Recent handoffs ===");
if (rows.length === 0) {
  console.log("  (none yet)");
} else {
  for (const r of rows) {
    const status = r.read_at ? `read by ${r.read_by || "?"}` : "UNREAD";
    console.log(`  #${r.id} [${status}] "${r.task}"${r.from_agent ? " from " + r.from_agent : ""}  @ ${r.created_at}`);
    console.log(`      ${r.summary}`);
  }
}

const mem = store.recall({});
console.log("\n=== Shared memory ===");
if (mem.length === 0) {
  console.log("  (empty)");
} else {
  for (const m of mem) console.log(`  ${m.key} = ${m.value}`);
}
