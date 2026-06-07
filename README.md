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

Both agents now share the same memory. Tip: tell agent B "read the handoff first"
at the start of a task so it picks up where A left off.

## Tools

| Tool | What it does |
|------|--------------|
| `write_handoff` | Save a summary + context for another agent to continue. |
| `read_handoff`  | Pick up the most recent handoff (optionally by task). |
| `list_handoffs` | See recent handoffs and whether they were picked up. |
| `remember`      | Write a value to the shared key/value memory. |
| `recall`        | Read from the shared memory (one key, or list all). |

## Dashboard

```bash
npm run web      # http://localhost:4317
```

A read-only view of the handoff timeline and shared memory pool.

## Roadmap

- **v0 (now):** handoff + shared memory between your own agents.
- **v1:** broader agent support, richer memory, visibility ("what does each agent know / has done").
- **v2:** active orchestration — auto-trigger B when A hands off, per-agent cost tracking.
- **v3+:** team mode (shared memory across people), permissions, audit, cost governance.

The throughline: a vendor-neutral layer that connects fragmented agents so your
work and memory flow between them.
