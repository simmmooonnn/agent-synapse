// agent-synapse team-mode server (the seam in backends/remote.js, now real).
//
// A small HTTP server that implements the exact API contract the remote backend
// client (src/backends/remote.js) expects, so multiple people/machines can share
// ONE store. Each WORKSPACE (the X-Workspace header) gets its own SQLite file, so
// teams are isolated from each other; within a workspace, handoffs stay scoped by
// project exactly like the single-user app.
//
// Run:   npm run serve            (defaults to port 4318)
//
// Auth (Bearer token), in priority order:
//   1. AGENT_SYNAPSE_TOKENS="tokenA:alice,tokenB:bob"   (token:identity pairs)
//   2. server/tokens.json  ->  { "tokenA": "alice", "tokenB": "bob" }
//   3. neither set -> OPEN dev mode (no auth; logs a warning)
//
// A client connects by pointing the remote backend at this server:
//   AGENT_SYNAPSE_BACKEND=remote
//   AGENT_SYNAPSE_REMOTE_URL=http://your-host:4318
//   AGENT_SYNAPSE_TOKEN=tokenA
//   AGENT_SYNAPSE_WORKSPACE=my-team

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteBackend } from "../src/backends/sqlite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENT_SYNAPSE_PORT) || 4318;
const SERVER_DATA = process.env.AGENT_SYNAPSE_SERVER_DATA || join(__dirname, "data");

// --- auth tokens ---
function loadTokens() {
  const map = new Map();
  if (process.env.AGENT_SYNAPSE_TOKENS) {
    for (const pair of process.env.AGENT_SYNAPSE_TOKENS.split(",")) {
      const [tok, name] = pair.split(":");
      if (tok) map.set(tok.trim(), (name || tok).trim());
    }
    return map;
  }
  const file = join(__dirname, "tokens.json");
  if (existsSync(file)) {
    try {
      const obj = JSON.parse(readFileSync(file, "utf8"));
      for (const [tok, name] of Object.entries(obj)) map.set(tok, name);
    } catch (e) {
      console.error("[agent-synapse] failed to read tokens.json:", e.message);
    }
  }
  return map;
}
const TOKENS = loadTokens();
const OPEN_MODE = TOKENS.size === 0;

// --- per-workspace backends (one SQLite file each), created lazily ---
const backends = new Map();
const safeWorkspace = (w) => (w || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default";
function backendFor(workspace) {
  const ws = safeWorkspace(workspace);
  if (!backends.has(ws)) backends.set(ws, createSqliteBackend({ dataDir: join(SERVER_DATA, ws) }));
  return backends.get(ws);
}

// --- route table: path -> (backend, body) => response object for the client ---
const routes = {
  "/handoffs/write": (b, x) => b.writeHandoff(x),
  "/handoffs/read": (b, x) => ({ handoff: b.readHandoff(x) }),
  "/handoffs/get": (b, x) => ({ handoff: b.getHandoff(x.id) }),
  "/handoffs/list": (b, x) => ({ handoffs: b.listHandoffs(x) }),
  "/handoffs/search": (b, x) => ({ handoffs: b.searchHandoffs(x) }),
  "/handoffs/thread": (b, x) => ({ handoffs: b.getThread(x.id) }),
  "/handoffs/set-status": (b, x) => ({ ok: b.setHandoffStatus(x.id, x.status, x.by ?? null) }),
  "/handoffs/stats": (b, x) => ({ stats: b.stats(x) }),
  "/handoffs/delete": (b, x) => ({ ok: b.deleteHandoff(x.id) }),
  "/handoffs/clear": (b, x) => ({ deleted: b.clearHandoffs(x) }),
  "/handoffs/latest-unread": (b, x) => ({ handoff: b.latestUnreadHandoff(x.project) }),
  "/handoffs/mark-read": (b, x) => { b.markRead(x.id, x.by ?? "auto-pickup"); return { ok: true }; },
  "/memory/set": (b, x) => b.remember(x),
  "/memory/get": (b, x) => (x.key ? { entry: b.recall(x) } : { entries: b.recall(x) }),
  "/memory/search": (b, x) => ({ entries: b.searchMemory(x) }),
  "/activity/list": (b, x) => ({ activity: b.getActivity(x) }),
  "/settings/get": (b, x) => ({ value: b.getSetting(x.key) }),
  "/settings/set": (b, x) => { b.setSetting(x.key, x.value); return { ok: true }; },
  "/settings/auto-pickup": (b, x) => ({ enabled: b.isAutoPickupOn(x.project ?? null) }),
  "/settings/auto-pickup/set": (b, x) => { b.setAutoPickup(x.enabled, x.project ?? null); return { ok: true }; },
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = createServer((req, res) => {
  // health check (no auth) for quick sanity / load balancers
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, mode: OPEN_MODE ? "open" : "auth", workspaces: [...backends.keys()] });
  }

  const handler = req.method === "POST" ? routes[req.url] : undefined;
  if (!handler) return send(res, 404, { error: "not found" });

  // auth
  let identity = "open";
  if (!OPEN_MODE) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token || !TOKENS.has(token)) return send(res, 401, { error: "unauthorized" });
    identity = TOKENS.get(token);
  }

  const workspace = req.headers["x-workspace"] || "default";
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 4_000_000) req.destroy(); // 4MB guard
  });
  req.on("end", () => {
    let args;
    try {
      args = body ? JSON.parse(body) : {};
    } catch {
      return send(res, 400, { error: "invalid JSON body" });
    }
    try {
      const result = handler(backendFor(workspace), args);
      send(res, 200, result ?? { ok: true });
    } catch (e) {
      console.error(`[agent-synapse] ${req.url} (ws=${workspace}, by=${identity}):`, e.message);
      send(res, 500, { error: e.message });
    }
  });
});

server.listen(PORT, () => {
  console.error(`[agent-synapse] team-mode server: http://localhost:${PORT}`);
  console.error(`[agent-synapse] data: ${SERVER_DATA}`);
  if (OPEN_MODE) {
    console.error("[agent-synapse] ⚠ OPEN MODE — no auth. Set AGENT_SYNAPSE_TOKENS or server/tokens.json before exposing this.");
  } else {
    console.error(`[agent-synapse] auth ON — ${TOKENS.size} token(s) loaded.`);
  }
});
