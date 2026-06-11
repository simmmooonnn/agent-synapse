// Local SQLite backend (default). Uses Node's built-in node:sqlite (Node >= 22.5)
// so there are no native modules to compile. WAL mode lets multiple agent
// processes share the DB concurrently.
//
// This is one implementation of the storage interface that src/store.js exposes.
// A second implementation (backends/remote.js) talks to a cloud API for team
// mode. Functions here are synchronous; the facade presents them as async so
// callers work the same against either backend.
//
// The backend is built by a FACTORY (createSqliteBackend) so it can be bound to
// any data directory. The single-user app uses one default instance (the named
// exports at the bottom); the team-mode server (server/remote-server.js) creates
// one instance PER WORKSPACE — a separate DB file each — getting full data
// isolation between teams for free, reusing all of this logic unchanged.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// data/ lives at the repo root (two levels up from src/backends/).
const DEFAULT_DATA_DIR = process.env.AGENT_SYNAPSE_DATA || join(__dirname, "..", "..", "data");

const now = () => new Date().toISOString();

const LIST_COLS =
  "id, project, task, summary, from_agent, created_at, read_at, read_by, reply_to, status, cost";

const autoKey = (project) => (project ? `auto_pickup:${project}` : "auto_pickup");

// Build a backend bound to its own SQLite file under `dataDir`.
export function createSqliteBackend({ dataDir = DEFAULT_DATA_DIR } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "synapse.db");

  const db = new DatabaseSync(dbPath);
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

  // Audit / activity feed: an append-only log of meaningful actions, so a team
  // can see who did what, when — and so the dashboard has a live "what's
  // happening" stream. action is a dotted verb (handoff.write, handoff.read,
  // handoff.status, handoff.delete, memory.set); target_id / detail give context.
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      actor      TEXT,
      action     TEXT NOT NULL,
      project    TEXT,
      target_id  INTEGER,
      detail     TEXT
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
  ensureColumn("handoffs", "cost", "REAL"); // optional self-reported cost (USD) of the work being handed off

  // Migration: rebuild a pre-existing memory table (PRIMARY KEY(key)) into the
  // project-scoped shape (PRIMARY KEY(key, project)). Existing rows become global
  // (project = ''). Fresh DBs already have the project column, so this is a no-op.
  (function migrateMemoryForProjectScope() {
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
  })();

  // --- Activity log (audit feed) ---

  // Append one entry to the activity feed. Best-effort: a logging failure must
  // never break the operation it is recording, so it swallows its own errors.
  function logActivity({ actor = null, action, project = null, target_id = null, detail = null }) {
    try {
      db.prepare(
        `INSERT INTO activity (at, actor, action, project, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(now(), actor, action, project, target_id, detail);
    } catch {
      /* never let auditing break the real work */
    }
  }

  // Recent activity, newest first. Optionally scope to a project or an actor.
  function getActivity({ limit = 50, project = null, actor = null } = {}) {
    const where = [];
    const params = [];
    if (project !== null) { where.push("project = ?"); params.push(project); }
    if (actor !== null) { where.push("actor = ?"); params.push(actor); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);
    return db
      .prepare(`SELECT id, at, actor, action, project, target_id, detail FROM activity ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params);
  }

  // --- Handoffs ---

  function writeHandoff({ task, summary, context = null, from_agent = null, project = null, reply_to = null, cost = null }) {
    const created_at = now();
    const info = db
      .prepare(
        `INSERT INTO handoffs (project, task, summary, context, from_agent, created_at, reply_to, status, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .run(project, task, summary, context, from_agent, created_at, reply_to, cost);
    const id = Number(info.lastInsertRowid);
    logActivity({ actor: from_agent, action: reply_to ? "handoff.reply" : "handoff.write", project, target_id: id, detail: task });
    return { id, task, project, created_at, reply_to };
  }

  function readHandoff({ id = null, task = null, as_agent = null, project = null } = {}) {
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
    const firstRead = row.read_at == null;
    db.prepare(`UPDATE handoffs SET read_at = ?, read_by = ? WHERE id = ?`).run(now(), as_agent, row.id);
    if (firstRead) logActivity({ actor: as_agent, action: "handoff.read", project: row.project, target_id: row.id, detail: row.task });
    return row;
  }

  function getHandoff(id) {
    return db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id) || null;
  }

  function listHandoffs({ limit = 20, project = null } = {}) {
    if (project !== null) {
      return db
        .prepare(`SELECT ${LIST_COLS} FROM handoffs WHERE project = ? ORDER BY id DESC LIMIT ?`)
        .all(project, limit);
    }
    return db.prepare(`SELECT ${LIST_COLS} FROM handoffs ORDER BY id DESC LIMIT ?`).all(limit);
  }

  // Full-text-ish search over task / summary / context (case-insensitive LIKE).
  function searchHandoffs({ query, project = null, limit = 20 }) {
    const like = `%${query}%`;
    const where = ["(task LIKE ? OR summary LIKE ? OR IFNULL(context,'') LIKE ?)"];
    const params = [like, like, like];
    if (project !== null) {
      where.push("project = ?");
      params.push(project);
    }
    params.push(limit);
    return db
      .prepare(`SELECT ${LIST_COLS} FROM handoffs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...params);
  }

  // The chain of handoffs leading to `id`: walk reply_to up to the root, return
  // it ordered root -> ... -> id so the reader sees the conversation in order.
  function getThread(id) {
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
  function setHandoffStatus(id, status, by = null) {
    const r = db
      .prepare(`UPDATE handoffs SET status = ?, status_at = ?, status_by = ? WHERE id = ?`)
      .run(status, now(), by, id);
    if (r.changes > 0) {
      const h = getHandoff(id);
      logActivity({ actor: by, action: "handoff.status", project: h?.project ?? null, target_id: id, detail: status });
    }
    return r.changes > 0;
  }

  // Per-project rollup for the dashboard / handoff_stats tool.
  function stats({ project = null } = {}) {
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
           SUM(CASE WHEN status = 'done'  THEN 1 ELSE 0 END) AS done,
           ROUND(SUM(IFNULL(cost, 0)), 4) AS cost
         FROM handoffs ${where}
         GROUP BY project ORDER BY total DESC`
      )
      .all(...params);
  }

  function deleteHandoff(id) {
    const h = getHandoff(id);
    const ok = db.prepare(`DELETE FROM handoffs WHERE id = ?`).run(id).changes > 0;
    if (ok) logActivity({ action: "handoff.delete", project: h?.project ?? null, target_id: id, detail: h?.task ?? null });
    return ok;
  }

  function clearHandoffs({ project = null } = {}) {
    if (project !== null) {
      return db.prepare(`DELETE FROM handoffs WHERE project = ?`).run(project).changes;
    }
    return db.prepare(`DELETE FROM handoffs`).run().changes;
  }

  // --- Memory (key/value, global or project-scoped) ---

  function remember({ key, value, agent = null, project = null }) {
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
    logActivity({ actor: agent, action: "memory.set", project: proj || null, detail: key });
    return { key, project: proj, updated_at };
  }

  // recall({ key })                 -> the GLOBAL entry for key (project = '')
  // recall({ key, project })        -> that project's entry for key
  // recall({})                      -> all GLOBAL entries
  // recall({ project })             -> all entries scoped to that project
  // recall({ all_projects: true })  -> every entry, global + project-scoped
  function recall({ key = null, project = null, all_projects = false } = {}) {
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
  function searchMemory({ query, limit = 50 }) {
    const like = `%${query}%`;
    return db
      .prepare(
        `SELECT key, project, value, updated_at, updated_by FROM memory
         WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT ?`
      )
      .all(like, like, limit);
  }

  // --- Settings + auto-pickup ---

  function getSetting(key) {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return r ? r.value : null;
  }

  function setSetting(key, value) {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  function isAutoPickupOn(project = null) {
    if (project) {
      const v = getSetting(autoKey(project));
      if (v !== null) return v === "on";
    }
    return getSetting("auto_pickup") === "on";
  }

  function setAutoPickup(enabled, project = null) {
    setSetting(autoKey(project), enabled ? "on" : "off");
  }

  function latestUnreadHandoff(project) {
    return (
      db
        .prepare(`SELECT * FROM handoffs WHERE project = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1`)
        .get(project) || null
    );
  }

  function markRead(id, by = "auto-pickup") {
    const h = getHandoff(id);
    const wasUnread = h && h.read_at == null;
    db.prepare(`UPDATE handoffs SET read_at = ?, read_by = ? WHERE id = ?`).run(now(), by, id);
    if (wasUnread) logActivity({ actor: by, action: "handoff.read", project: h.project, target_id: id, detail: h.task });
  }

  return {
    DATA_DIR: dataDir,
    DB_PATH: dbPath,
    close: () => db.close(),
    writeHandoff, readHandoff, getHandoff, listHandoffs, searchHandoffs, getThread,
    setHandoffStatus, stats, deleteHandoff, clearHandoffs,
    remember, recall, searchMemory,
    getActivity,
    getSetting, setSetting, isAutoPickupOn, setAutoPickup, latestUnreadHandoff, markRead,
  };
}

// Default instance — the single-user, one-DB API the rest of the app imports.
const _default = createSqliteBackend();

export const DATA_DIR = _default.DATA_DIR;
export const DB_PATH = _default.DB_PATH;
export const writeHandoff = _default.writeHandoff;
export const readHandoff = _default.readHandoff;
export const getHandoff = _default.getHandoff;
export const listHandoffs = _default.listHandoffs;
export const searchHandoffs = _default.searchHandoffs;
export const getThread = _default.getThread;
export const setHandoffStatus = _default.setHandoffStatus;
export const stats = _default.stats;
export const deleteHandoff = _default.deleteHandoff;
export const clearHandoffs = _default.clearHandoffs;
export const remember = _default.remember;
export const recall = _default.recall;
export const searchMemory = _default.searchMemory;
export const getActivity = _default.getActivity;
export const getSetting = _default.getSetting;
export const setSetting = _default.setSetting;
export const isAutoPickupOn = _default.isAutoPickupOn;
export const setAutoPickup = _default.setAutoPickup;
export const latestUnreadHandoff = _default.latestUnreadHandoff;
export const markRead = _default.markRead;
