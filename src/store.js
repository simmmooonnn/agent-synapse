// Storage facade. Picks a backend and re-exports a single, uniform async
// interface, so the MCP tools never care whether data lives in a local SQLite
// file or a shared cloud store.
//
//   AGENT_SYNAPSE_BACKEND = "sqlite" (default) | "remote"
//
// All storage calls are async (await them) — the local backend is synchronous
// under the hood, but awaiting a plain value is a no-op, so callers are uniform
// against either backend.

import * as sqlite from "./backends/sqlite.js";
import * as remote from "./backends/remote.js";

const backendName = (process.env.AGENT_SYNAPSE_BACKEND || "sqlite").toLowerCase();
const backend = backendName === "remote" ? remote : sqlite;

export const ACTIVE_BACKEND = backendName === "remote" ? "remote" : "sqlite";

// --- storage interface (delegates to the active backend) ---
export const writeHandoff = (...a) => backend.writeHandoff(...a);
export const readHandoff = (...a) => backend.readHandoff(...a);
export const getHandoff = (...a) => backend.getHandoff(...a);
export const listHandoffs = (...a) => backend.listHandoffs(...a);
export const searchHandoffs = (...a) => backend.searchHandoffs(...a);
export const getThread = (...a) => backend.getThread(...a);
export const setHandoffStatus = (...a) => backend.setHandoffStatus(...a);
export const stats = (...a) => backend.stats(...a);
export const deleteHandoff = (...a) => backend.deleteHandoff(...a);
export const clearHandoffs = (...a) => backend.clearHandoffs(...a);
export const restoreHandoff = (...a) => backend.restoreHandoff(...a);
export const listTrash = (...a) => backend.listTrash(...a);
export const purgeHandoff = (...a) => backend.purgeHandoff(...a);
export const emptyTrash = (...a) => backend.emptyTrash(...a);
export const remember = (...a) => backend.remember(...a);
export const recall = (...a) => backend.recall(...a);
export const searchMemory = (...a) => backend.searchMemory(...a);
export const getActivity = (...a) => backend.getActivity(...a);
export const getSetting = (...a) => backend.getSetting(...a);
export const setSetting = (...a) => backend.setSetting(...a);
export const isAutoPickupOn = (...a) => backend.isAutoPickupOn(...a);
export const setAutoPickup = (...a) => backend.setAutoPickup(...a);
export const latestUnreadHandoff = (...a) => backend.latestUnreadHandoff(...a);
export const markRead = (...a) => backend.markRead(...a);

// Local helper (not a backend op): which project the current agent is in.
// The project is the agent's working directory; override with AGENT_SYNAPSE_PROJECT.
export function currentProject() {
  return process.env.AGENT_SYNAPSE_PROJECT || process.cwd();
}
