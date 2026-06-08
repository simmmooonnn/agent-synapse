#!/usr/bin/env node
// Claude Code SessionStart hook for agent-synapse auto-pickup.
//
// When auto-pickup is switched ON, this injects the latest UNREAD handoff for
// the current project into the new session's context — so the agent continues
// where the previous one left off without you telling it to "read the handoff".
// When the switch is OFF (the default), it outputs nothing and does nothing.
//
// Wired into Claude Code via a SessionStart hook (see README / `npm run config`).
// Only plain stdout is injected as context, so stdout is kept clean. Any error
// is swallowed so a hiccup here can never break your session.

try {
  const store = await import("../src/store.js");
  const project = store.currentProject();

  if (store.isAutoPickupOn(project)) {
    const h = store.latestUnreadHandoff(project);
    if (h) {
      store.markRead(h.id, "auto-pickup");
      const lines = [
        `[agent-synapse] Auto-pickup: another agent left a handoff for this project. Continue from where it left off.`,
        ``,
        `Handoff #${h.id} — task: "${h.task}"${h.from_agent ? ` (from ${h.from_agent})` : ""}`,
        ``,
        `SUMMARY:`,
        h.summary,
      ];
      if (h.context) lines.push(``, `CONTEXT:`, h.context);
      process.stdout.write(lines.join("\n") + "\n");
    }
  }
} catch {
  // never break the session
}
process.exit(0);
