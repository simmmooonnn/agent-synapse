// MCP tool definitions. The descriptions matter a lot: agents decide WHEN to
// call these based on the text here, so they are written as instructions to the
// agent, not just docs for humans.
//
// Handoffs are scoped to a PROJECT (v1). By default the project is the directory
// the agent launched this server from, so handoffs auto-scope to whatever you
// are working on. Reads default to the current project; pass all_projects:true
// to look across everything.

import { z } from "zod";
import { basename } from "node:path";
import * as store from "./store.js";

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

const projName = (p) => (p ? basename(p) : "(none)");

function formatHandoff(h) {
  const readState = h.read_at ? `read by ${h.read_by || "?"}` : "unread";
  const lines = [
    `Handoff #${h.id} — task: "${h.task}"  [project: ${projName(h.project)}]`,
    h.reply_to ? `In reply to: #${h.reply_to}` : null,
    h.from_agent ? `From: ${h.from_agent}` : null,
    `Status: ${h.status || "open"} · ${readState}`,
    `Created: ${h.created_at}`,
    ``,
    `SUMMARY:`,
    h.summary,
  ];
  if (h.context) lines.push(``, `CONTEXT:`, h.context);
  return lines.filter((l) => l !== null).join("\n");
}

// One-line form used by list/search results.
function formatHandoffLine(h, { showProject = false } = {}) {
  const status = h.read_at ? `read by ${h.read_by || "?"}` : "UNREAD";
  const life = h.status && h.status !== "open" ? ` ${h.status.toUpperCase()}` : "";
  const projTag = showProject ? ` {${projName(h.project)}}` : "";
  const reply = h.reply_to ? ` ↳#${h.reply_to}` : "";
  return `#${h.id} [${status}${life}]${projTag}${reply} "${h.task}"${h.from_agent ? ` from ${h.from_agent}` : ""} — ${h.summary.slice(0, 80)}`;
}

function formatMemoryLine(m) {
  const scope = m.project ? `{${projName(m.project)}} ` : "";
  return `${scope}${m.key} = ${m.value}`;
}

// Human-readable verbs for the activity feed.
const ACTION_VERB = {
  "handoff.write": "wrote handoff",
  "handoff.reply": "replied to handoff",
  "handoff.read": "read handoff",
  "handoff.status": "set status",
  "handoff.delete": "deleted handoff",
  "memory.set": "set memory",
};

function formatActivityLine(a) {
  const verb = ACTION_VERB[a.action] || a.action;
  const who = a.actor || "someone";
  const target =
    a.action === "memory.set"
      ? ` "${a.detail}"`
      : a.action === "handoff.status"
        ? ` #${a.target_id} → ${a.detail}`
        : a.target_id != null
          ? ` #${a.target_id}${a.detail ? ` "${a.detail}"` : ""}`
          : "";
  const proj = a.project ? ` {${projName(a.project)}}` : "";
  return `${when(a.at)} — ${who} ${verb}${target}${proj}`;
}

function when(iso) {
  return (iso || "").replace("T", " ").replace(/\.\d+Z$/, "").slice(0, 16);
}

export function registerTools(server) {
  server.registerTool(
    "write_handoff",
    {
      title: "Write Handoff",
      description:
        "Call this when you finish a task (or a meaningful chunk of work) that " +
        "another agent might continue. Save a concise summary of what you did " +
        "plus any context the next agent needs (decisions made, files touched, " +
        "open questions, next steps). The handoff is automatically scoped to the " +
        "current project, so it will only surface for agents working on the same " +
        "project. This replaces copy-pasting your summary into another window.",
      inputSchema: {
        task: z.string().describe("Short label for the task, e.g. 'auth refactor'. Used to look the handoff up later."),
        summary: z.string().describe("Concise summary of what was done and the current state."),
        context: z.string().optional().describe("Anything the next agent needs: key decisions, files changed, gotchas, next steps."),
        from_agent: z.string().optional().describe("Who is handing off, e.g. 'claude-code' or 'codex'."),
        project: z.string().optional().describe("Override the project this handoff belongs to. Omit to use the current project automatically."),
        reply_to: z.number().int().positive().optional().describe("The #id of a handoff this one is replying to. Links them into a thread so the next agent sees the conversation in order."),
        cost: z.number().nonnegative().optional().describe("Optional: the cost in USD of the work being handed off (e.g. your session's token spend), so the team can see cost per project in handoff_stats."),
      },
    },
    async ({ task, summary, context, from_agent, project, reply_to, cost }) => {
      const proj = project ?? store.currentProject();
      const r = await store.writeHandoff({ task, summary, context, from_agent, project: proj, reply_to, cost });
      const replyNote = reply_to ? ` (reply to #${reply_to})` : "";
      return text(`Saved handoff #${r.id} for task "${r.task}" in project "${projName(proj)}"${replyNote}.`);
    }
  );

  server.registerTool(
    "read_handoff",
    {
      title: "Read Handoff",
      description:
        "Call this at the START of a task to pick up context another agent " +
        "handed off FOR THIS PROJECT. With no arguments it returns the most " +
        "recent handoff in the current project. Pass `id` to read a specific " +
        "handoff (get ids from list_handoffs), `task` to filter by label, or " +
        "all_projects:true to look beyond the current project. Pass thread:true " +
        "to also see the whole chain of handoffs this one replies to.",
      inputSchema: {
        id: z.number().int().positive().optional().describe("Read this specific handoff by its #id (from list_handoffs). Ignores project/task scoping."),
        task: z.string().optional().describe("Optional task label to fetch a specific handoff. Omit to get the most recent one in this project."),
        as_agent: z.string().optional().describe("Who is reading, e.g. 'codex'. Recorded so the dashboard shows the handoff was picked up."),
        all_projects: z.boolean().optional().describe("Search across all projects instead of just the current one. Default false."),
        project: z.string().optional().describe("Read from a specific project instead of the current one."),
        thread: z.boolean().optional().describe("Also return the full chain of handoffs this one is a reply to (root first). Default false."),
      },
    },
    async ({ id, task, as_agent, all_projects, project, thread }) => {
      const proj = id != null ? null : all_projects ? null : project ?? store.currentProject();
      const h = await store.readHandoff({ id, task, as_agent, project: proj });
      if (!h) {
        if (id != null) return text(`No handoff with id ${id}.`);
        const scope = all_projects ? "any project" : `project "${projName(proj)}"`;
        return text(task ? `No handoff found for task "${task}" in ${scope}.` : `No handoffs yet in ${scope}.`);
      }
      if (thread) {
        const chain = await store.getThread(h.id);
        if (chain.length > 1) {
          const sep = "\n\n" + "─".repeat(48) + "\n\n";
          return text(`Thread of ${chain.length} handoffs (oldest first):\n\n` + chain.map(formatHandoff).join(sep));
        }
      }
      return text(formatHandoff(h));
    }
  );

  server.registerTool(
    "list_handoffs",
    {
      title: "List Handoffs",
      description:
        "List recent handoffs (newest first) for the current project to see " +
        "what work has been passed around and what is waiting to be picked up. " +
        "Each line starts with the #id you can pass to read_handoff or " +
        "delete_handoff. Set all_projects:true to list across every project.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe("How many to return (default 20)."),
        all_projects: z.boolean().optional().describe("List across all projects instead of just the current one. Default false."),
        project: z.string().optional().describe("List a specific project instead of the current one."),
      },
    },
    async ({ limit, all_projects, project }) => {
      const proj = all_projects ? null : project ?? store.currentProject();
      const rows = await store.listHandoffs({ limit: limit ?? 20, project: proj });
      if (rows.length === 0) {
        return text(all_projects ? "No handoffs yet." : `No handoffs yet in project "${projName(proj)}".`);
      }
      const out = rows.map((h) => formatHandoffLine(h, { showProject: all_projects })).join("\n");
      return text(out);
    }
  );

  server.registerTool(
    "search_handoffs",
    {
      title: "Search Handoffs",
      description:
        "Search handoffs by keyword across their task label, summary, and " +
        "context. Defaults to the current project; pass all_projects:true to " +
        "search everywhere. Use this to find an earlier handoff when you don't " +
        "know its #id — e.g. search 'auth' or 'migration'.",
      inputSchema: {
        query: z.string().describe("Keyword or phrase to look for (case-insensitive substring match)."),
        limit: z.number().int().positive().max(100).optional().describe("How many to return (default 20)."),
        all_projects: z.boolean().optional().describe("Search across all projects instead of just the current one. Default false."),
        project: z.string().optional().describe("Search a specific project instead of the current one."),
      },
    },
    async ({ query, limit, all_projects, project }) => {
      const proj = all_projects ? null : project ?? store.currentProject();
      const rows = await store.searchHandoffs({ query, limit: limit ?? 20, project: proj });
      if (rows.length === 0) {
        const scope = all_projects ? "any project" : `project "${projName(proj)}"`;
        return text(`No handoffs matching "${query}" in ${scope}.`);
      }
      return text(rows.map((h) => formatHandoffLine(h, { showProject: all_projects })).join("\n"));
    }
  );

  server.registerTool(
    "set_handoff_status",
    {
      title: "Set Handoff Status",
      description:
        "Move a handoff through its lifecycle: 'open' (needs attention), " +
        "'acked' (someone picked it up / is working on it), or 'done' " +
        "(finished). This is separate from read/unread — a handoff can be read " +
        "but still open. Use it to signal whether the handed-off work is " +
        "actually resolved.",
      inputSchema: {
        id: z.number().int().positive().describe("The #id of the handoff (from list_handoffs)."),
        status: z.enum(["open", "acked", "done"]).describe("New status: open, acked, or done."),
        by: z.string().optional().describe("Who changed the status, e.g. 'codex'."),
      },
    },
    async ({ id, status, by }) => {
      const ok = await store.setHandoffStatus(id, status, by ?? null);
      return text(ok ? `Handoff #${id} marked ${status}.` : `No handoff with id ${id}.`);
    }
  );

  server.registerTool(
    "handoff_stats",
    {
      title: "Handoff Stats",
      description:
        "Get a per-project rollup of handoffs: how many total, how many still " +
        "unread, and how many are open / acked / done. Use it to see at a glance " +
        "where work is waiting to be picked up. Defaults to all projects; pass " +
        "this_project:true to scope to the current one.",
      inputSchema: {
        this_project: z.boolean().optional().describe("Only count the current project instead of all projects. Default false."),
      },
    },
    async ({ this_project }) => {
      const proj = this_project ? store.currentProject() : null;
      const rows = await store.stats({ project: proj });
      if (rows.length === 0) return text(this_project ? `No handoffs in project "${projName(proj)}".` : "No handoffs yet.");
      const out = rows
        .map((s) => {
          const pending = Number(s.total) - Number(s.done);
          const cost = Number(s.cost) > 0 ? ` · $${Number(s.cost).toFixed(2)}` : "";
          return `${projName(s.project)}: ${s.total} total · ${s.unread} unread · ${s.open} open · ${s.acked} acked · ${s.done} done · ${pending} not-done${cost}`;
        })
        .join("\n");
      return text(out);
    }
  );

  server.registerTool(
    "recent_activity",
    {
      title: "Recent Activity",
      description:
        "Show the recent activity feed — an audit log of what agents have been " +
        "doing: handoffs written, read, status changes, deletions, and memory " +
        "updates (newest first). Use it to catch up on what changed since you " +
        "last looked, especially in team mode where others share this store. " +
        "Defaults to all projects; pass this_project:true to scope to the current " +
        "one, or actor to filter by who did it.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe("How many entries to return (default 30)."),
        this_project: z.boolean().optional().describe("Only show activity in the current project. Default false (all projects)."),
        actor: z.string().optional().describe("Only show activity by this actor, e.g. 'codex'."),
      },
    },
    async ({ limit, this_project, actor }) => {
      const proj = this_project ? store.currentProject() : null;
      const rows = await store.getActivity({ limit: limit ?? 30, project: proj, actor: actor ?? null });
      if (!rows || rows.length === 0) {
        return text(this_project ? `No activity yet in project "${projName(proj)}".` : "No activity yet.");
      }
      return text(rows.map(formatActivityLine).join("\n"));
    }
  );

  server.registerTool(
    "delete_handoff",
    {
      title: "Delete Handoff",
      description:
        "Delete a specific handoff by its #id (get ids from list_handoffs). Use " +
        "when a handoff is done with, was wrong, or is just clutter. Deletes one " +
        "handoff at a time on purpose, so nothing is removed by accident.",
      inputSchema: {
        id: z.number().int().positive().describe("The #id of the handoff to delete."),
      },
    },
    async ({ id }) => {
      const ok = await store.deleteHandoff(id);
      return text(ok ? `Deleted handoff #${id}.` : `No handoff with id ${id}.`);
    }
  );

  server.registerTool(
    "set_auto_pickup",
    {
      title: "Set Auto-Pickup",
      description:
        "Turn auto-pickup on or off. When ON, a new agent session automatically " +
        "receives the latest unread handoff for the project at startup (via the " +
        "Claude Code SessionStart hook) — you don't have to ask it to read the " +
        "handoff. This sets the global switch by default; pass this_project_only:" +
        "true to set it for the current project only.",
      inputSchema: {
        enabled: z.boolean().describe("true to turn auto-pickup on, false to turn it off."),
        this_project_only: z.boolean().optional().describe("Apply only to the current project instead of globally. Default false (global)."),
      },
    },
    async ({ enabled, this_project_only }) => {
      const proj = this_project_only ? store.currentProject() : null;
      await store.setAutoPickup(enabled, proj);
      const scope = proj ? `project "${projName(proj)}"` : "all projects (global)";
      return text(`Auto-pickup turned ${enabled ? "ON" : "OFF"} for ${scope}.`);
    }
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Write a value to the shared memory scratchpad under a key. By default " +
        "this memory is GLOBAL across all projects — any agent can recall it " +
        "later. Use global for facts that should persist everywhere: the user's " +
        "preferences, writing style, durable conventions. Pass this_project:true " +
        "to scope the memory to the current project instead (same key can hold a " +
        "different value per project).",
      inputSchema: {
        key: z.string().describe("Identifier for this memory, e.g. 'user.style'."),
        value: z.string().describe("The value to store."),
        agent: z.string().optional().describe("Who is writing this, e.g. 'claude-code'."),
        this_project: z.boolean().optional().describe("Scope this memory to the current project instead of global. Default false (global)."),
      },
    },
    async ({ key, value, agent, this_project }) => {
      const proj = this_project ? store.currentProject() : null;
      const r = await store.remember({ key, value, agent, project: proj });
      const scope = proj ? `project "${projName(proj)}"` : "global";
      return text(`Remembered "${r.key}" (${scope}) at ${r.updated_at}.`);
    }
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Read from the shared memory scratchpad. By default reads GLOBAL memory: " +
        "give a key to fetch one value, or omit it to list all global entries. " +
        "Pass this_project:true to read the current project's scoped memory, or " +
        "all_projects:true to list every entry (global + all project-scoped).",
      inputSchema: {
        key: z.string().optional().describe("Key to fetch. Omit to list entries."),
        this_project: z.boolean().optional().describe("Read the current project's scoped memory instead of global. Default false."),
        all_projects: z.boolean().optional().describe("When listing, include every project's memory plus global. Default false."),
      },
    },
    async ({ key, this_project, all_projects }) => {
      const proj = this_project ? store.currentProject() : null;
      const r = await store.recall({ key, project: proj, all_projects });
      if (key) {
        if (!r) return text(`Nothing stored under "${key}"${proj ? ` for project "${projName(proj)}"` : " (global)"}.`);
        const scope = r.project ? `{${projName(r.project)}} ` : "";
        return text(`${scope}${r.key} = ${r.value}\n(updated ${r.updated_at}${r.updated_by ? ` by ${r.updated_by}` : ""})`);
      }
      if (!r || r.length === 0) return text("Shared memory is empty.");
      return text(r.map(formatMemoryLine).join("\n"));
    }
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search Memory",
      description:
        "Search the shared memory scratchpad by keyword across keys and values " +
        "(global and project-scoped together). Use it to find a remembered fact " +
        "when you don't know its exact key.",
      inputSchema: {
        query: z.string().describe("Keyword or phrase to look for (case-insensitive substring match)."),
        limit: z.number().int().positive().max(200).optional().describe("How many to return (default 50)."),
      },
    },
    async ({ query, limit }) => {
      const rows = await store.searchMemory({ query, limit: limit ?? 50 });
      if (!rows || rows.length === 0) return text(`No memory entries matching "${query}".`);
      return text(rows.map(formatMemoryLine).join("\n"));
    }
  );
}
