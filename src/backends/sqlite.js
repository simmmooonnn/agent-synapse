// Local SQLite backend (default). Uses Node's built-in node:sqlite (Node >= 22.5)
// so there are no native modules to compile. WAL mode lets multiple agent
// processes share the DB concurrently.
//
// This is one implementation of the storage interface that src/store.js exposes.
// A second implementation (backends/remote.js) talks to a cloud API for team
// mode. Functions here are synchronous; the facade presents them as async so
// callers work the same against either backend.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// data/ lives at the repo root (two levels up from src/backends/).
export const DATA_DIR = process.env.AGENT_SYNAPSE_DATA || join(__dirname, "..", "..", "data");
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
    read_by     TEXT,
    reply_to    INTEGER,
    status      TEXT,
    status_at   TEXT,
    status_by   TEXT
  );
`);

// Memory is keyed by (key, project). project = '' means the GLOBAL scratchpad
// (the original behaviour); a non-empty project scopes the entry to that project.
db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    key         TEXT NOT NULL,
    project     TEXT NOT NULL DEFAULT '',
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT,
    PRIMARY KEY (key, project)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: add columns to DBs created before the feature that introduced them.
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn("handoffs", "project", "TEXT"); // v1
ensureColumn("handoffs", "reply_to", "INTEGER"); // threading
ensureColumn("handoffs", "status", "TEXT"); // lifecycle: open | acked | done
ensureColumn("handoffs", "status_at", "TEXT");
ensureColumn("handoffs", "status_by", "TEXT");

// Migration: rebuild a pre-existing memory table (PRIMARY KEY(key)) into the
// project-scoped shape (PRIMARY KEY(key, project)). Existing rows become global
// (project = ''). Fresh DBs already have the project column, so this is a no-op.
function migrateMemoryForProjectScope() {
  const cols = db.prepare(`PRAGMA table_info(memory)`).all();
  if (cols.some((c) => c.name === "project")) return;
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE memory_new (
        key         TEXT NOT NULL,
        project     TEXT NOT NULL DEFAULT '',
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  TEXT,
        PRIMARY KEY (key, project)
      );
    `);
    db.exec(`
      INSERT INTO memory_new (key, project, value, updated_at, updated_by)
      SELECT key, '', value, updated_at, updated_by FROM memory;
    `);
    db.exec(`DROP TABLE memory;`);
    db.exec(`ALTER TABLE memory_new RENAME TO memory;`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
migrateMemoryForProjectScope();

const now = () => new Date().toISOString();

// --- Handoffs ---

export function writeHandoff({ task, summary, context = null, from_agent = null, project = null, reply_to = null }) {
  const created_at = now();
  const info = db
    .prepare(
      `INSERT INTO handoffs (project, task, summary, context, from_agent, created_at, reply_to, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
    )
    .run(project, task, summary, context, from_agent, created_at, reply_to);
  return { id: Number(info.lastInsertRowid), task, project, created_at, reply_to };
}

export function readHandoff({ id = null, task = null, as_agent = null, project = null } = {}) {
  let row;
  if (id != null) {
    row = db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id);
  } else {
    const where = [];
    const params = [];
    if (project !== null) { where.push("project = ?"); params.push(project); }
    if (task) { where.push("task = ?"); params.push(task); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    row = db.prepare(`SELECT * FROM handoffs ${clause} ORDER BY id DESC LIMIT 1`).get(...params);
  }
  if (!row) return null;
  db.prepare(`UPDATE handoffs SET read_at = ?, read_by = ? WHERE id = ?`).run(now(), as_agent, row.id);
  return row;
}

export function getHandoff(id) {
  return db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id) || null;
}

const LIST_COLS =
  "id, project, task, summary, from_agent, created_at, read_at, read_by, reply_to, status";

export function listHandoffs({ limit = 20, project = null } = {}) {
  if (project !== null) {
    return db
      .prepare(
        `SELECT ${LIST_COLS}
         FROM handoffs WHERE project = ? ORDER BY id DESC LIMIT ?`
      )
      .all(project, limit);
  }
  return db
    .prepare(
      `SELECT ${LIST_COLS}
       FROM handoffs ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}

// Full-text-ish search over task / summary / context (case-insensitive LIKE).
export function searchHandoffs({ query, project = null, limit = 20 }) {
  const like = `%${query}%`;
  const where = ["(task LIKE ? OR summary LIKE ? OR IFNULL(context,'') LIKE ?)"];
  const params = [like, like, like];
  if (project !== null) {
    where.push("project = ?");
    params.push(project);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT ${LIST_COLS}
       FROM handoffs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`
    )
    .all(...params);
}

// The chain of handoffs leading to `id`: walk reply_to up to the root, return
// it ordered root -> ... -> id so the reader sees the conversation in order.
export function getThread(id) {
  const chain = [];
  const seen = new Set();
  let cur = getHandoff(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.reply_to != null ? getHandoff(cur.reply_to) : null;
  }
  return chain;
}

// Lifecycle status beyond just read/unread: open | acked | done.
export function setHandoffStatus(id, status, by = null) {
  const r = db
    .prepare(`UPDATE handoffs SET status = ?, status_at = ?, status_by = ? WHERE id = ?`)
    .run(status, now(), by, id);
  return r.changes > 0;
}

// Per-project rollup for the dashboard / handoff_stats tool.
export function stats({ project = null } = {}) {
  const where = project !== null ? "WHERE project = ?" : "";
  const params = project !== null ? [project] : [];
  return db
    .prepare(
      `SELECT
         project,
         COUNT(*) AS total,
         SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
         SUM(CASE WHEN IFNULL(status,'open') = 'open'  THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status = 'acked' THEN 1 ELSE 0 END) AS acked,
         SUM(CASE WHEN status = 'done'  THEN 1 ELSE 0 END) AS done
       FROM handoffs ${where}
       GROUP BY project ORDER BY total DESC`
    )
    .all(...params);
}

export function deleteHandoff(id) {
  return db.prepare(`DELETE FROM handoffs WHERE id = ?`).run(id).changes > 0;
}

export function clearHandoffs({ project = null } = {}) {
  if (project !== null) {
    return db.prepare(`DELETE FROM handoffs WHERE project = ?`).run(project).changes;
  }
  return db.prepare(`DELETE FROM handoffs`).run().changes;
}

// --- Memory (global key/value) ---

export function remember({ key, value, agent = null, project = null }) {
  const updated_at = now();
  const proj = project ?? "";
  db.prepare(
    `INSERT INTO memory (key, project, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key, project) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(key, proj, value, updated_at, agent);
  return { key, project: proj, updated_at };
}

// recall({ key })                 -> the GLOBAL entry for key (project = '')
// recall({ key, project })        -> that project's entry for key
// recall({})                      -> all GLOBAL entries
// recall({ project })             -> all entries scoped to that project
// recall({ all_projects: true })  -> every entry, global + project-scoped
export function recall({ key = null, project = null, all_projects = false } = {}) {
  if (key) {
    return db.prepare(`SELECT * FROM memory WHERE key = ? AND project = ?`).get(key, project ?? "") || null;
  }
  if (all_projects) {
    return db
      .prepare(`SELECT key, project, value, updated_at, updated_by FROM memory ORDER BY updated_at DESC`)
      .all();
  }
  return db
    .prepare(`SELECT key, project, value, updated_at, updated_by FROM memory WHERE project = ? ORDER BY updated_at DESC`)
    .all(project ?? "");
}

// Search across all memory (global + project-scoped) by key or value.
export function searchMemory({ query, limit = 50 }) {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT key, project, value, updated_at, updated_by FROM memory
       WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT ?`
    )
    .all(like, like, limit);
}

// --- Settings + auto-pickup ---

export function getSetting(key) {
  const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return r ? r.value : null;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

const autoKey = (project) => (project ? `auto_pickup:${project}` : "auto_pickup");

export function isAutoPickupOn(project = null) {
  if (project) {
    const v = getSetting(autoKey(project));
    if (v !== null) return v === "on";
  }
  return getSetting("auto_pickup") === "on";
}

export function setAutoPickup(enabled, project = null) {
  setSetting(autoKey(project), enabled ? "on" : "off");
}

export function latestUnreadHandoff(project) {
  return (
    db
      .prepare(`SELECT * FROM handoffs WHERE project = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(project) || null
  );
}

export function markRead(id, by = "auto-pickup") {
  db.prepare(`UPDATE handoffs SET read_at = ?, read_by = ? WHERE id = ?`).run(now(), by, id);
}
