// The auto-pickup master switch (global), from the command line.
//
//   npm run autopickup        # show current state
//   npm run autopickup on     # turn on
//   npm run autopickup off    # turn off
//
// Per-project overrides can be set from an agent via the set_auto_pickup tool
// (this_project_only:true), since this CLI runs from the repo, not your project.

import * as store from "../src/store.js";

const arg = (process.argv[2] || "").toLowerCase();

if (arg === "on" || arg === "off") {
  store.setAutoPickup(arg === "on", null);
  console.log(`Auto-pickup (global) is now ${arg.toUpperCase()}.`);
} else {
  const state = (store.getSetting("auto_pickup") || "off").toUpperCase();
  console.log(`Auto-pickup (global): ${state}`);
  console.log("Usage: npm run autopickup on   |   npm run autopickup off");
}
