# agent-synapse

A shared memory layer that lets your AI coding agents (Claude Code, Codex, …)
hand off context to each other — **no copy-paste**.

Today you have to make one agent summarize its work, copy that summary, and
paste it into another agent's window. agent-synapse removes that loop: it runs a
small local [MCP](https://modelcontextprotocol.io) server that both agents
connect to, so one agent writes a handoff and another reads it directly.

> **v0 scope:** asynchronous handoff + a shared key/value memory, for your own
> agents on your own machine. No real-time sync, no orchestration, no cloud —
> those come later. See "Roadmap" below.

## How it works

```
Agent A (Claude Code)                 Agent B (Codex)
  finishes a task                       starts the next task
        │                                     │
        │ write_handoff(task, summary, ctx)   │ read_handoff(task)
        ▼                                     ▼
   ┌─────────────────── agent-synapse MCP server ───────────────────┐
   │                  SQLite store (data/synapse.db)                 │
   └────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ read-only
                          Dashboard (web/)
```

Three ways to reach the same store:
- **Agents** call the MCP tools automatically while they work.
- **You** open the dashboard (`npm run web`) to see what's flowing.
- **Scripts** can import `src/store.js` directly.

## Setup

Requires **Node.js >= 22.5** (uses the built-in `node:sqlite`).

```bash
npm install
```

## Connect your agents

Use the absolute path to `src/server.js` on your machine.

### Claude Code
Add to your project's `.mcp.json` (or run `claude mcp add`):

```json
{
  "mcpServers": {
    "agent-synapse": {
      "command": "node",
      "args": ["E:\\Work_Startup\\Work_Agent\\agent-synapse\\src\\server.js"]
    }
  }
}
```

### Codex CLI
Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-synapse]
command = "node"
args = ["E:\\Work_Startup\\Work_Agent\\agent-synapse\\src\\server.js"]
```

### Any other agent
Any MCP-capable agent (Cursor, Cline, Windsurf, Zed, Gemini CLI, …) connects the
same way — run `npm run config` to print ready-to-paste config for each.

Both agents now share the same memory. Tip: tell agent B "read the handoff first"
at the start of a task so it picks up where A left off.

## Project isolation (v1)

Handoffs are **scoped to a project** so work from different projects doesn't mix.
The project is detected automatically from the directory the agent launched the
server in, so you don't have to tag anything — work in a folder, and handoffs
auto-scope to it. `read_handoff` / `list_handoffs` default to the current
project; pass `all_projects: true` to look across everything.

If a particular agent doesn't launch the server from your project directory, set
the project explicitly in that agent's MCP config:

```toml
[mcp_servers.agent-synapse.env]
AGENT_SYNAPSE_PROJECT = "my-project"
```

The shared **memory** scratchpad (`remember` / `recall`) stays **global** across
all projects — use it for durable, cross-cutting facts (preferences, style).

## Tools

| Tool | What it does |
|------|--------------|
| `write_handoff` | Save a summary + context for another agent to continue. |
| `read_handoff`  | Pick up a handoff — most recent, by `task`, or a specific `id`. |
| `list_handoffs` | See recent handoffs (each line starts with its `#id`) and whether they were picked up. |
| `delete_handoff`| Remove one handoff by its `#id`. |
| `set_auto_pickup`| Turn auto-pickup on/off (global, or `this_project_only`). |
| `remember`      | Write a value to the shared key/value memory. |
| `recall`        | Read from the shared memory (one key, or list all). |

## Dashboard

```bash
npm run web      # http://localhost:4317
```

Shows the handoff timeline (with project tags) and shared memory pool. Hover a
handoff and click ✕ to delete it.

## Managing handoffs

- Delete one: `delete_handoff` tool with its `#id`, or the ✕ button in the dashboard.
- Bulk clear: `npm run clear` (all) or `npm run clear -- "project-name"` (one project).

## Auto-pickup (v2)

Instead of telling agent B to "read the handoff", auto-pickup injects the latest
**unread** handoff for the current project into a new Claude Code session
automatically. It's **off by default** — flip the switch when you want it:

- Dashboard: the **auto-pickup** toggle in the header.
- CLI: `npm run autopickup on` / `npm run autopickup off`.
- From an agent: the `set_auto_pickup` tool (add `this_project_only: true` to scope it).

It works via a Claude Code **SessionStart hook** in your `settings.json` (user scope
applies everywhere):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node \"E:\\Work_Startup\\Work_Agent\\agent-synapse\\scripts\\session-start-hook.mjs\"" }
      ] }
    ]
  }
}
```

The hook does nothing while the switch is off, so it's safe to leave installed. Once
a handoff is auto-picked-up it's marked read, so it won't be injected again. (The hook
is Claude Code-specific; for other agents, just tell them to call `read_handoff` at the
start of a task.)

## Roadmap

- **v0:** handoff + shared memory between your own agents. ✅
- **v1:** project isolation, read/delete by id, connect-any-agent config. ✅ — next: auto-pickup, richer visibility.
- **v2:** auto-pickup (handoffs auto-injected at session start, toggleable). ✅ — next: per-agent cost tracking.
- **v3+:** team mode (shared memory across people), permissions, audit, cost governance.

The throughline: a vendor-neutral layer that connects fragmented agents so your
work and memory flow between them.
