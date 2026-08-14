import { dashboardExists } from "../session.js";
import { readDashState, withStateLock } from "../dashboard/state.js";
import {
  respawnStatusPane,
  respawnUsagePane,
  respawnHistoryPane,
  respawnAlertsPane,
} from "../dashboard/create.js";
import { refreshDashboard, writeAlertsRendered } from "../dashboard/header.js";
import { output } from "../output.js";

// Rebuild the dashboard's passive panes from a known-good state. The
// status/usage/history/alerts panes are long-lived shell loops that repaint
// pre-baked files on SIGUSR1; a loop that wedges or duplicates (a signal
// landing in a fork window) leaves the pane frozen or garbled with no way to
// heal short of re-attaching. respawn-pane -k kills each pane's whole process
// group, so no wedged or duplicated loop survives a redraw. Content is
// re-baked first so the fresh loops paint current state on their first read.
export async function redraw(_args: string[]): Promise<void> {
  if (!dashboardExists()) {
    output(
      { redrawn: false, reason: "no-dashboard" },
      () => "No dashboard session running — nothing to redraw.",
    );
    return;
  }
  withStateLock(() => {
    const state = readDashState();
    try { refreshDashboard({ state }); } catch { /* best effort — stale bake still paints */ }
    try { writeAlertsRendered({ state }); } catch { /* best effort */ }
    respawnStatusPane(state);
    respawnUsagePane(state);
    respawnHistoryPane(state);
    respawnAlertsPane(state);
  });
  output(
    { redrawn: true },
    () => "Dashboard redrawn: status, usage, history, and alerts panes respawned from freshly baked content.",
  );
}
