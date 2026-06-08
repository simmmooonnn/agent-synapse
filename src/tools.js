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
  const lines = [
    `Handoff #${h.id} — task: "${h.task}"  [project: ${projName(h.project)}]`,
    h.from_agent ? `From: ${h.from_agent}` : null,
    `Created: ${h.created_at}`,
    ``,
    `SUMMARY:`,
    h.summary,
  ];
  if (h.context) lines.push(``, `CONTEXT:`, h.context);
  return lines.filter((l) => l !== null).join("\n");
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
      },
    },
    async ({ task, summary, context, from_agent, project }) => {
      const proj = project ?? store.currentProject();
      const r = await store.writeHandoff({ task, summary, context, from_agent, project: proj });
      return text(`Saved handoff #${r.id} for task "${r.task}" in project "${projName(proj)}".`);
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
        "all_projects:true to look beyond the current project.",
      inputSchema: {
        id: z.number().int().positive().optional().describe("Read this specific handoff by its #id (from list_handoffs). Ignores project/task scoping."),
        task: z.string().optional().describe("Optional task label to fetch a specific handoff. Omit to get the most recent one in this project."),
        as_agent: z.string().optional().describe("Who is reading, e.g. 'codex'. Recorded so the dashboard shows the handoff was picked up."),
        all_projects: z.boolean().optional().describe("Search across all projects instead of just the current one. Default false."),
        project: z.string().optional().describe("Read from a specific project instead of the current one."),
      },
    },
    async ({ id, task, as_agent, all_projects, project }) => {
      const proj = id != null ? null : all_projects ? null : project ?? store.currentProject();
      const h = await store.readHandoff({ id, task, as_agent, project: proj });
      if (!h) {
        if (id != null) return text(`No handoff with id ${id}.`);
        const scope = all_projects ? "any project" : `project "${projName(proj)}"`;
        return text(task ? `No handoff found for task "${task}" in ${scope}.` : `No handoffs yet in ${scope}.`);
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
      const out = rows
        .map((h) => {
          const status = h.read_at ? `read by ${h.read_by || "?"}` : "UNREAD";
          const projTag = all_projects ? ` {${projName(h.project)}}` : "";
          return `#${h.id} [${status}]${projTag} "${h.task}"${h.from_agent ? ` from ${h.from_agent}` : ""} — ${h.summary.slice(0, 80)}`;
        })
        .join("\n");
      return text(out);
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
        "Write a value to the shared memory scratchpad under a key. This memory " +
        "is GLOBAL across all projects — any agent can recall it later. Use for " +
        "facts that should persist everywhere: the user's preferences, writing " +
        "style, durable conventions, etc.",
      inputSchema: {
        key: z.string().describe("Identifier for this memory, e.g. 'user.style'."),
        value: z.string().describe("The value to store."),
        agent: z.string().optional().describe("Who is writing this, e.g. 'claude-code'."),
      },
    },
    async ({ key, value, agent }) => {
      const r = await store.remember({ key, value, agent });
      return text(`Remembered "${r.key}" at ${r.updated_at}.`);
    }
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description: "Read from the shared (global) memory scratchpad. Give a key to fetch one value, or omit it to list everything stored.",
      inputSchema: {
        key: z.string().optional().describe("Key to fetch. Omit to list all keys and values."),
      },
    },
    async ({ key }) => {
      const r = await store.recall({ key });
      if (key) {
        if (!r) return text(`Nothing stored under "${key}".`);
        return text(`${r.key} = ${r.value}\n(updated ${r.updated_at}${r.updated_by ? ` by ${r.updated_by}` : ""})`);
      }
      if (!r || r.length === 0) return text("Shared memory is empty.");
      return text(r.map((m) => `${m.key} = ${m.value}`).join("\n"));
    }
  );
}
