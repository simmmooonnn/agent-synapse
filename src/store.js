// Storage layer for agent-synapse.
// Uses Node's built-in SQLite (node:sqlite, Node >= 22.5) so there are no
// native modules to compile. WAL mode lets multiple agent processes read/write
// the same DB concurrently without corrupting each other.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Where the shared memory lives. Override with AGENT_SYNAPSE_DATA if you want a
// single shared DB across machines/checkouts.
export const DATA_DIR = process.env.AGENT_SYNAPSE_DATA || join(__dirname, "..", "data");
export const DB_PATH = join(DATA_DIR, "synapse.db");

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS handoffs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task        TEXT NOT NULL,
    summary     TEXT NOT NULL,
    context     TEXT,
    from_agent  TEXT,
    created_at  TEXT NOT NULL,
    read_at     TEXT,
    read_by     TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
  );
`);

const now = () => new Date().toISOString();

// --- Handoffs: A finishes work and leaves a note for B to pick up ---

export function writeHandoff({ task, summary, context = null, from_agent = null }) {
  const created_at = now();
  const info = db
    .prepare(
      `INSERT INTO handoffs (task, summary, context, from_agent, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(task, summary, context, from_agent, created_at);
  return { id: Number(info.lastInsertRowid), task, created_at };
}

// Returns the most recent handoff (optionally filtered by task) and marks it as
// read so the UI can show whether it was picked up.
export function readHandoff({ task = null, as_agent = null } = {}) {
  const row = task
    ? db.prepare(`SELECT * FROM handoffs WHERE task = ? ORDER BY id DESC LIMIT 1`).get(task)
    : db.prepare(`SELECT * FROM handoffs ORDER BY id DESC LIMIT 1`).get();

  if (!row) return null;

  db.prepare(`UPDATE handoffs SET read_at = ?, read_by = ? WHERE id = ?`).run(
    now(),
    as_agent,
    row.id
  );
  return row;
}

export function listHandoffs({ limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT id, task, summary, from_agent, created_at, read_at, read_by
       FROM handoffs ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}

// --- Memory: a shared key/value scratchpad any agent can read or write ---

export function remember({ key, value, agent = null }) {
  const updated_at = now();
  db.prepare(
    `INSERT INTO memory (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(key, value, updated_at, agent);
  return { key, updated_at };
}

export function recall({ key = null } = {}) {
  if (key) {
    return db.prepare(`SELECT * FROM memory WHERE key = ?`).get(key) || null;
  }
  return db
    .prepare(`SELECT key, value, updated_at, updated_by FROM memory ORDER BY updated_at DESC`)
    .all();
}
