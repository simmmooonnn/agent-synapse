// Remote backend (cloud / team mode) — THE SEAM, NOT YET ACTIVE.
//
// This talks to a hosted agent-synapse API so multiple people/machines can share
// one store. The server does not exist yet; this file defines the client + the
// API contract the server will need to implement. Activate by setting:
//
//   AGENT_SYNAPSE_BACKEND=remote
//   AGENT_SYNAPSE_REMOTE_URL=https://your-host
//   AGENT_SYNAPSE_TOKEN=...          (who you are)
//   AGENT_SYNAPSE_WORKSPACE=...      (which shared store)
//
// Same function names/shapes as backends/sqlite.js, so src/store.js can swap
// between them with zero changes to the tools.

const BASE = process.env.AGENT_SYNAPSE_REMOTE_URL;
const TOKEN = process.env.AGENT_SYNAPSE_TOKEN;
const WORKSPACE = process.env.AGENT_SYNAPSE_WORKSPACE || "";

async function call(path, body = {}) {
  if (!BASE) {
    throw new Error(
      "Remote backend selected but AGENT_SYNAPSE_REMOTE_URL is not set. " +
        "The cloud server is not built yet — see backends/remote.js."
    );
  }
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: TOKEN ? `Bearer ${TOKEN}` : "",
      "X-Workspace": WORKSPACE,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`agent-synapse remote ${path} -> HTTP ${res.status}`);
  return res.json();
}

// --- Handoffs ---
export async function writeHandoff(args) {
  return call("/handoffs/write", args);
}
export async function readHandoff(args = {}) {
  return (await call("/handoffs/read", args)).handoff ?? null;
}
export async function getHandoff(id) {
  return (await call("/handoffs/get", { id })).handoff ?? null;
}
export async function listHandoffs(args = {}) {
  return (await call("/handoffs/list", args)).handoffs ?? [];
}
export async function searchHandoffs(args = {}) {
  return (await call("/handoffs/search", args)).handoffs ?? [];
}
export async function getThread(id) {
  return (await call("/handoffs/thread", { id })).handoffs ?? [];
}
export async function setHandoffStatus(id, status, by = null) {
  return (await call("/handoffs/set-status", { id, status, by })).ok === true;
}
export async function stats(args = {}) {
  return (await call("/handoffs/stats", args)).stats ?? [];
}
export async function deleteHandoff(id) {
  return (await call("/handoffs/delete", { id })).ok === true;
}
export async function clearHandoffs(args = {}) {
  return (await call("/handoffs/clear", args)).deleted ?? 0;
}

// --- Memory ---
export async function remember(args) {
  return call("/memory/set", args);
}
export async function recall(args = {}) {
  const r = await call("/memory/get", args);
  return args.key ? r.entry ?? null : r.entries ?? [];
}
export async function searchMemory(args = {}) {
  return (await call("/memory/search", args)).entries ?? [];
}

// --- Activity feed ---
export async function getActivity(args = {}) {
  return (await call("/activity/list", args)).activity ?? [];
}

// --- Settings + auto-pickup ---
export async function getSetting(key) {
  return (await call("/settings/get", { key })).value ?? null;
}
export async function setSetting(key, value) {
  return call("/settings/set", { key, value });
}
export async function isAutoPickupOn(project = null) {
  return (await call("/settings/auto-pickup", { project })).enabled === true;
}
export async function setAutoPickup(enabled, project = null) {
  return call("/settings/auto-pickup/set", { enabled, project });
}
export async function latestUnreadHandoff(project) {
  return (await call("/handoffs/latest-unread", { project })).handoff ?? null;
}
export async function markRead(id, by = "auto-pickup") {
  return call("/handoffs/mark-read", { id, by });
}
