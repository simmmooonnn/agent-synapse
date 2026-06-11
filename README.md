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

**One command:** `npm run connect` auto-configures the agents it finds on this
machine (Claude Code + Codex) and prints snippets for the rest. Or configure them
manually below (use the absolute path to `src/server.js` on your machine).

> Each machine keeps its own `data/synapse.db`, so this connects *your* agents to
> *your* store. To share one store across multiple people/machines you'd need a
> shared backend — that's team mode (see Roadmap), not built yet.

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
| `write_handoff` | Save a summary + context for another agent to continue. Pass `reply_to` to chain it onto an earlier handoff, or `cost` to report what the work cost. |
| `read_handoff`  | Pick up a handoff — most recent, by `task`, or a specific `id`. Pass `thread: true` to get the whole reply chain. |
| `list_handoffs` | See recent handoffs (each line starts with its `#id`) and whether they were picked up. |
| `search_handoffs` | Find handoffs by keyword across task / summary / context. |
| `set_handoff_status` | Move a handoff through its lifecycle: `open` → `acked` → `done`. |
| `handoff_stats` | Per-project rollup: total / unread / open / acked / done, plus total reported cost. |
| `recent_activity` | Audit feed of what agents did (writes, reads, status changes, deletes, memory sets). `this_project` / `actor` to filter. |
| `delete_handoff`| Soft-delete one handoff by its `#id` — it goes to the recycle bin, recoverable. |
| `restore_handoff`| Bring a soft-deleted handoff back out of the recycle bin. |
| `list_trash` | List handoffs in the recycle bin (each line starts with its `#id`). |
| `set_auto_pickup`| Turn auto-pickup on/off (global, or `this_project_only`). |
| `remember`      | Write a value to the shared key/value memory. Pass `this_project: true` to scope it to the current project. |
| `recall`        | Read from memory (one key, or list all). `this_project` for project-scoped, `all_projects` to list everything. |
| `search_memory` | Find memory entries by keyword across keys and values. |

## Finding things: search, threads, status

As handoffs pile up, three things keep them usable:

- **Search** — `search_handoffs` / `search_memory` do a keyword lookup when you
  don't know the `#id`. Handoff search defaults to the current project
  (`all_projects: true` to widen); memory search spans global + project-scoped.
- **Threads** — reply to a handoff with `write_handoff(..., reply_to: <id>)` to
  link a back-and-forth. `read_handoff(id, thread: true)` returns the whole chain
  oldest-first, so the next agent gets the full conversation, not just the last note.
- **Status** — a handoff is `open` when written; `set_handoff_status` moves it to
  `acked` (someone's on it) or `done` (resolved). This is separate from read/unread
  — a handoff can be read but still open. `handoff_stats` rolls these up per project
  so you can see where work is waiting.

## Project-scoped memory

`remember` / `recall` are **global** by default (preferences, style — facts that
apply everywhere). Pass `this_project: true` to scope an entry to the current
project instead; the same key can then hold a different value per project. Listing:
`recall()` shows global, `recall({ this_project: true })` shows this project's,
`recall({ all_projects: true })` shows everything.

## Activity feed & cost

- **Activity feed** — every meaningful action (handoff written, read, status
  change, deletion, memory set) is appended to an audit log. `recent_activity`
  shows it newest-first; pass `this_project:true` or `actor:"codex"` to filter.
  In team mode this is how you catch up on what teammates did. The feed is part
  of each workspace's store, so it stays isolated per team.
- **Cost** — `write_handoff` takes an optional `cost` (USD) so an agent can
  report what a chunk of work cost (e.g. its token spend). `handoff_stats` and
  the dashboard roll that up per project, so cost is attributed where it accrued.

## Dashboard

```bash
npm run web      # http://localhost:4317
```

Shows a per-project stats strip (with rolled-up cost), a live **Activity** feed,
the handoff timeline (with project tags, status, and reply links), and the shared
memory pool. Search boxes filter each column; status buttons (open / acked / done)
and the ✕ delete button act on a handoff inline. The status tabs include a
**Trash** tab (restore / delete-forever / empty), and the header has a **Backup**
button.

## Managing handoffs

- Delete one: `delete_handoff` tool with its `#id`, or the ✕ button in the dashboard.
  This is a **soft delete** — the handoff goes to the recycle bin and can be
  brought back with `restore_handoff` (or the Trash tab in the dashboard).
- Bulk clear: `npm run clear` (all) or `npm run clear -- "project-name"` (one project).
  This is a hard delete, so it **takes a full backup first** by default
  (`--no-backup` to skip).

## Data safety: recycle bin & backups

Your store is a single local SQLite file with no remote copy, so destructive
actions are cushioned:

- **Recycle bin** — `delete_handoff` is a soft delete: the row is hidden from
  reads/lists/search/stats but kept, and `restore_handoff` undoes it. See what's
  in the bin with `list_trash` (or the dashboard's **Trash** tab, where you can
  Restore, Delete-forever, or Empty trash). Bulk `npm run clear` is the one hard
  delete — and it backs up first.
- **Backups** — `npm run backup` writes two files under `data/backups/`
  (git-ignored): a consistent `synapse-<timestamp>.db` file snapshot (the WAL is
  checkpointed first so the copy is complete) and a portable
  `export-<timestamp>.json` dump (handoffs incl. the recycle bin, memory,
  activity, settings) that survives even if the DB/schema changes. The dashboard
  header has a **Backup** button that does the same. To restore, copy a snapshot
  back over `data/synapse.db` (with the server stopped).

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

## Storage backend

Storage lives behind one facade (`src/store.js`) with swappable backends, so the
MCP tools never change:

- `sqlite` (default) — a local file at `data/synapse.db`. Single user, this machine.
- `remote` — an HTTP client (`src/backends/remote.js`) that talks to the team-mode
  server (below) so multiple people/machines share one store.

## Team mode (shared store across people/machines)

Run one server; everyone points their agents at it and shares handoffs + memory.
Each **workspace** (a team) gets its own isolated store on the server; within a
workspace, handoffs stay scoped by project exactly as in single-user mode.

**1. Run the server** (on a host everyone can reach):

```bash
# define who can connect (token:identity pairs), then start it
AGENT_SYNAPSE_TOKENS="tok_alice:alice,tok_bob:bob" npm run serve   # port 4318
```

Tokens can also live in `server/tokens.json` (`{ "tok_alice": "alice" }`). With no
tokens set, the server runs in **open mode** (no auth) — fine for a trusted LAN,
not for anything exposed. Per-workspace SQLite files live under `server/data/`
(git-ignored). `GET /health` returns status without auth.

**2. Point each agent at it** via the MCP server's env (in `.mcp.json` /
`config.toml`):

```
AGENT_SYNAPSE_BACKEND=remote
AGENT_SYNAPSE_REMOTE_URL=http://your-host:4318
AGENT_SYNAPSE_TOKEN=tok_alice
AGENT_SYNAPSE_WORKSPACE=my-team
```

That's it — agents on different machines now read and write the same handoffs and
memory, as long as they share a `WORKSPACE`. Different workspaces never see each
other's data. `npm run test:team` exercises the whole path (shared visibility,
workspace isolation, auth) end-to-end.

## Roadmap

- **v0:** handoff + shared memory between your own agents. ✅
- **v1:** project isolation, read/delete by id, connect-any-agent config. ✅
- **v2:** auto-pickup (handoffs auto-injected at session start, toggleable). ✅
- **v2.1:** search, reply threads, handoff status + stats, project-scoped memory. ✅
- **v3:** team mode — shared store across people/machines via the remote server, with
  per-workspace isolation and token auth. ✅
- **v3.1:** activity feed (audit log) + per-handoff cost tracking, rolled up per project. ✅
- **v3.2:** data safety — soft-delete recycle bin (restore) + DB snapshot / JSON
  export backups, with an auto-backup before bulk clear. ✅

The throughline: a vendor-neutral layer that connects fragmented agents so your
work and memory flow between them.
