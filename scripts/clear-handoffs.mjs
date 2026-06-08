// Bulk-delete handoffs from the command line.
//
//   node scripts/clear-handoffs.mjs                 # delete ALL handoffs
//   node scripts/clear-handoffs.mjs "my-project"    # delete one project's
//
// (For deleting a single handoff, use the delete_handoff tool with its #id,
//  or the ✕ button in the dashboard.)

import * as store from "../src/store.js";

const project = process.argv[2] || null;
const n = store.clearHandoffs({ project });
console.log(`Deleted ${n} handoff(s)${project ? ` in project "${project}"` : " (all projects)"}.`);
