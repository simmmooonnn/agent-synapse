// Day-2 read-only dashboard. Serves a single page that shows the handoff
// timeline and the shared memory pool, reading from the SAME SQLite DB the MCP
// server writes to. Read-only: it never mutates anything.
//
// Run with:  npm run web   (then open http://localhost:4317)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4317;

const server = createServer(async (req, res) => {
  if (req.method === "DELETE" && req.url.startsWith("/api/handoff/")) {
    const id = parseInt(req.url.split("/").pop(), 10);
    const ok = Number.isInteger(id) ? await store.deleteHandoff(id) : false;
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (req.method === "POST" && req.url.match(/^\/api\/handoff\/\d+\/restore$/)) {
    const id = parseInt(req.url.split("/")[3], 10);
    const ok = Number.isInteger(id) ? await store.restoreHandoff(id) : false;
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (req.method === "POST" && req.url.match(/^\/api\/handoff\/\d+\/purge$/)) {
    const id = parseInt(req.url.split("/")[3], 10);
    const ok = Number.isInteger(id) ? await store.purgeHandoff(id) : false;
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/trash/empty") {
    const deleted = await store.emptyTrash();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, deleted }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/backup") {
    try {
      const { backup } = await import("../scripts/backup.mjs");
      const { dbDest, jsonDest } = backup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, dbDest, jsonDest }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url.match(/^\/api\/handoff\/\d+\/status$/)) {
    const id = parseInt(req.url.split("/")[3], 10);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { status } = JSON.parse(body || "{}");
        const valid = ["open", "acked", "done"].includes(status);
        const ok = valid && Number.isInteger(id) ? await store.setHandoffStatus(id, status, "dashboard") : false;
        res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/autopickup")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { enabled } = JSON.parse(body || "{}");
        await store.setAutoPickup(!!enabled, null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, auto_pickup: !!enabled }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  if (req.url.startsWith("/api/data")) {
    const data = {
      handoffs: await store.listHandoffs({ limit: 100 }),
      memory: await store.recall({ all_projects: true }),
      stats: await store.stats({}),
      activity: await store.getActivity({ limit: 50 }),
      trash: await store.listTrash({ limit: 100 }),
      auto_pickup: (await store.getSetting("auto_pickup")) === "on",
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
    return;
  }

  try {
    const html = readFileSync(join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end("Failed to load UI");
  }
});

server.listen(PORT, () => {
  console.error(`[agent-synapse] dashboard: http://localhost:${PORT}`);
});
