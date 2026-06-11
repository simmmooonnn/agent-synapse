// Safe backup / export of the local store (data safety).
//
//   npm run backup            (or: node scripts/backup.mjs)
//
// Writes two things under data/backups/ (data/ is git-ignored, so backups are
// never committed):
//   synapse-<timestamp>.db    — a consistent file snapshot. The WAL is flushed
//                               into the main DB first, so the copy is complete
//                               (recent writes otherwise live only in the -wal).
//   export-<timestamp>.json   — a portable dump (handoffs INCLUDING the recycle
//                               bin, memory, activity, settings) that survives
//                               even if the SQLite file or schema later changes.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sqlite from "../src/backends/sqlite.js";

// A filename-safe timestamp like 2026-06-10_19-40-12 (local node script, so the
// Date APIs are fine here — they're only restricted inside Workflow scripts).
function stamp() {
  return new Date().toISOString().replace("T", "_").replace(/:/g, "-").replace(/\..+$/, "");
}

// Snapshot the DB file + write a JSON export. Returns the paths and counts.
export function backup() {
  const backupDir = join(sqlite.DATA_DIR, "backups");
  mkdirSync(backupDir, { recursive: true });
  const ts = stamp();

  sqlite.checkpoint(); // flush WAL so the file copy is a complete snapshot

  const dbDest = join(backupDir, `synapse-${ts}.db`);
  copyFileSync(sqlite.DB_PATH, dbDest);

  const dump = sqlite.exportAll();
  const jsonDest = join(backupDir, `export-${ts}.json`);
  writeFileSync(jsonDest, JSON.stringify(dump, null, 2), "utf8");

  return { dbDest, jsonDest, dump };
}

// Run the backup when this file is executed directly (not when imported).
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const { dbDest, jsonDest, dump } = backup();
  console.log(
    `Backed up ${dump.handoffs.length} handoff(s), ${dump.memory.length} memory entr(ies), ` +
      `${dump.activity.length} activity row(s).`
  );
  console.log(`  DB snapshot : ${dbDest}`);
  console.log(`  JSON export : ${jsonDest}`);
}
