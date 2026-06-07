// MCP tool definitions. The descriptions matter a lot: agents decide WHEN to
// call these based on the text here, so they are written as instructions to the
// agent, not just docs for humans.

import { z } from "zod";
import * as store from "./store.js";

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function formatHandoff(h) {
  const lines = [
    `Handoff #${h.id} — task: "${h.task}"`,
    h.from_agent ? `From: ${h.from_agent}` : null,
    `Created: ${h.created_at}`,
    ``,
    `SUMMARY:`,
    h.summary,
  ];
  if (h.context) {
    lines.push(``, `CONTEXT:`, h.context);
  }
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
        "open questions, next steps). This replaces copy-pasting your summary " +
        "into another agent's window.",
      inputSchema: {
        task: z.string().describe("Short label for the task, e.g. 'auth refactor'. Used to look the handoff up later."),
        summary: z.string().describe("Concise summary of what was done and the current state."),
        context: z.string().optional().describe("Anything the next agent needs: key decisions, files changed, gotchas, next steps."),
        from_agent: z.string().optional().describe("Who is handing off, e.g. 'claude-code' or 'codex'."),
      },
    },
    async ({ task, summary, context, from_agent }) => {
      const r = store.writeHandoff({ task, summary, context, from_agent });
      return text(`Saved handoff #${r.id} for task "${r.task}" at ${r.created_at}.`);
    }
  );

  server.registerTool(
    "read_handoff",
    {
      title: "Read Handoff",
      description:
        "Call this at the START of a task to pick up context that another agent " +
        "handed off. Returns the most recent handoff (optionally filtered by " +
        "task label). Use it so you continue where the other agent left off " +
        "instead of starting cold.",
      inputSchema: {
        task: z.string().optional().describe("Optional task label to fetch a specific handoff. Omit to get the most recent one."),
        as_agent: z.string().optional().describe("Who is reading, e.g. 'codex'. Recorded so the dashboard shows the handoff was picked up."),
      },
    },
    async ({ task, as_agent }) => {
      const h = store.readHandoff({ task, as_agent });
      if (!h) {
        return text(task ? `No handoff found for task "${task}".` : "No handoffs yet.");
      }
      return text(formatHandoff(h));
    }
  );

  server.registerTool(
    "list_handoffs",
    {
      title: "List Handoffs",
      description: "List recent handoffs (newest first) to see what work has been passed around and what is waiting to be picked up.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe("How many to return (default 20)."),
      },
    },
    async ({ limit }) => {
      const rows = store.listHandoffs({ limit: limit ?? 20 });
      if (rows.length === 0) return text("No handoffs yet.");
      const out = rows
        .map((h) => {
          const status = h.read_at ? `read by ${h.read_by || "?"} @ ${h.read_at}` : "UNREAD";
          return `#${h.id} [${status}] "${h.task}"${h.from_agent ? ` from ${h.from_agent}` : ""} — ${h.summary.slice(0, 80)}`;
        })
        .join("\n");
      return text(out);
    }
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Write a value to the shared memory scratchpad under a key. Any agent " +
        "can recall it later. Use for facts that should persist across agents " +
        "and sessions: project conventions, decisions, the user's preferences, " +
        "important paths, etc.",
      inputSchema: {
        key: z.string().describe("Identifier for this memory, e.g. 'db.schema' or 'user.style'."),
        value: z.string().describe("The value to store."),
        agent: z.string().optional().describe("Who is writing this, e.g. 'claude-code'."),
      },
    },
    async ({ key, value, agent }) => {
      const r = store.remember({ key, value, agent });
      return text(`Remembered "${r.key}" at ${r.updated_at}.`);
    }
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description: "Read from the shared memory scratchpad. Give a key to fetch one value, or omit it to list everything stored.",
      inputSchema: {
        key: z.string().optional().describe("Key to fetch. Omit to list all keys and values."),
      },
    },
    async ({ key }) => {
      const r = store.recall({ key });
      if (key) {
        if (!r) return text(`Nothing stored under "${key}".`);
        return text(`${r.key} = ${r.value}\n(updated ${r.updated_at}${r.updated_by ? ` by ${r.updated_by}` : ""})`);
      }
      if (!r || r.length === 0) return text("Shared memory is empty.");
      return text(r.map((m) => `${m.key} = ${m.value}`).join("\n"));
    }
  );
}
