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
    project     TEXT,
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

// --- Migration: add the project column to DBs created before v1 ---
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn("handoffs", "project", "TEXT");

const now = () => new Date().toISOString();

// The project a handoff belongs to. Defaults to the directory the agent
// launched the MCP server from (so handoffs auto-scope to whatever project you
// are working in). Override per project with AGENT_SYNAPSE_PROJECT.
export function currentProject() {
  return process.env.AGENT_SYNAPSE_PROJECT || process.cwd();
}

// --- Handoffs: A finishes work and leaves a note for B to pick up ---
// A null `project` argument means "across all projects".

export function writeHandoff({ task, summary, context = null, from_agent = null, project = null }) {
  const created_at = now();
  const info = db
    .prepare(
      `INSERT INTO handoffs (project, task, summary, context, from_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(project, task, summary, context, from_agent, created_at);
  return { id: Number(info.lastInsertRowid), task, project, created_at };
}

// Returns the most recent handoff and marks it read. Scoped to `project` unless
// project is null (then it searches across all projects).
export function readHandoff({ task = null, as_agent = null, project = null } = {}) {
  const where = [];
  const params = [];
  if (project !== null) { where.push("project = ?"); params.push(project); }
  if (task) { where.push("task = ?"); params.push(task); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const row = db.prepare(`SELECT * FROM handoffs ${clause} ORDER BY id DESC LIMIT 1`).get(...params);
  if (!row) return null;

  db.prepare(`UPDATE handoffs SET read_at = ?, read_by = ? WHERE id = ?`).run(now(), as_agent, row.id);
  return row;
}

export function listHandoffs({ limit = 20, project = null } = {}) {
  if (project !== null) {
    return db
      .prepare(
        `SELECT id, project, task, summary, from_agent, created_at, read_at, read_by
         FROM handoffs WHERE project = ? ORDER BY id DESC LIMIT ?`
      )
      .all(project, limit);
  }
  return db
    .prepare(
      `SELECT id, project, task, summary, from_agent, created_at, read_at, read_by
       FROM handoffs ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}

// --- Memory: a shared key/value scratchpad, global across all projects ---

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
