// Reconciles the terminal's column split — what `layout.leftPercent` says the
// left column should be against what the tmux panes actually show.
//
// The four tmux sites that size the right slot all fire on an EVENT: dashboard
// creation, attach, right-slot repair, and the `client-resized` handler. That
// left a gap with no event in it — a config value that changes while a session
// stays attached (an operator edit, a `⌥;` selection, or a new build changing
// the default) is not applied until the operator happens to detach or resize
// their terminal. Observed as exactly that: a merged 45/55 default sat on a
// live 50/50 dashboard, because the post-rebuild refresh respawns the status
// and logs panes but never touches widths.
//
// So the watchdog reconciles it, like every other drift it owns. The comparison
// is configured-value vs `DashboardState.appliedLeftPercent` — the last value
// APPLIED — deliberately, rather than against measured pane widths: an operator
// dragging a pane border leaves config untouched and so is never fought, while
// a genuinely changed setting is applied within one tick.
//
// header.ts and create.ts pull the dashboard graph, so they are imported
// dynamically here (the same reason the menus do it): this module stays light
// enough for the watchdog and the menu to share one writer.
import { getLeftColumnPercent } from "../config.js";
import { readDashState, writeDashState, withStateLock } from "./state.js";
import { log } from "./log.js";

export interface ColumnSplitResult {
  applied: boolean;
  leftPercent: number;
}

// Apply the configured split if the panes are not already showing it. Returns
// whether anything moved. Safe to call with no live dashboard — the pane work
// throws and is swallowed, and the applied marker is only written once the
// panes actually took it, so the next tick retries.
export async function reconcileColumnSplit(): Promise<ColumnSplitResult> {
  const leftPercent = getLeftColumnPercent();
  const state = readDashState();
  if (state.appliedLeftPercent === leftPercent) return { applied: false, leftPercent };
  if (!state.activePaneId) return { applied: false, leftPercent };

  // Exactly the terminal-resize path: `rebakePanesOnResize` resizes the right
  // slot to the configured percent and re-renders the width-shaped baked files,
  // then `presizeHiddenWindows` carries the new width to parked worker windows.
  // Changing the ratio moves the same widths a resize moves, so it must repair
  // the same things.
  const { USAGE_PANE_HEIGHT, presizeHiddenWindows } = await import("./create.js");
  const { rebakePanesOnResize } = await import("./header.js");
  rebakePanesOnResize(state, USAGE_PANE_HEIGHT);
  presizeHiddenWindows(state);

  recordAppliedColumnSplit(leftPercent);
  log.info("layout", "column split applied", { data: { leftPercent } });
  return { applied: true, leftPercent };
}

// Mark a split as applied without re-applying it — for the sites that size the
// right slot themselves (dashboard creation, attach). Without this their work
// would look like drift to the reconciler and earn a redundant rebake on the
// next tick.
export function recordAppliedColumnSplit(leftPercent: number): void {
  withStateLock(() => {
    const fresh = readDashState();
    fresh.appliedLeftPercent = leftPercent;
    writeDashState(fresh);
  });
}
