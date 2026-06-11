// Bulk-delete handoffs from the command line.
//
//   node scripts/clear-handoffs.mjs                 # delete ALL handoffs
//   node scripts/clear-handoffs.mjs "my-project"    # delete one project's
//   node scripts/clear-handoffs.mjs --no-backup ... # skip the safety backup
//
// This is a HARD bulk delete (unlike the single-handoff delete_handoff, which is
// a recoverable soft delete). Because it's irreversible, it takes a full backup
// first by default — see scripts/backup.mjs. For one handoff, use delete_handoff
// with its #id, or the ✕ button in the dashboard.

import * as store from "../src/store.js";
import { backup } from "./backup.mjs";

const args = process.argv.slice(2);
const noBackup = args.includes("--no-backup");
const project = args.find((a) => !a.startsWith("--")) || null;

if (!noBackup) {
  const { dbDest } = backup();
  console.log(`Safety backup written before clearing → ${dbDest}`);
}

const n = await store.clearHandoffs({ project });
console.log(`Deleted ${n} handoff(s)${project ? ` in project "${project}"` : " (all projects)"}.`);
