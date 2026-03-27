// Pane parking and restoring: swaps content between the visible right slot
// and hidden tmux windows so the layout tree is never modified.
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, getFirstPaneId, windowExists, killWindowSafe, paneExists } from "./tmux.js";
import type { DashboardState } from "./state.js";

/**
 * Park the visible right pane's content into a hidden window.
 * After this, the right slot contains a temporary empty shell.
 * Returns the temp pane ID now in the right slot.
 */
export function parkToHidden(windowName: string, state: DashboardState): string | null {
  if (!state.activePaneId || !paneExists(state.activePaneId)) return null;

  if (windowExists(windowName)) {
    killWindowSafe(windowName);
  }

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName);
  const tempPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (!tempPaneId) return null;

  // Swap: active content goes to hidden window, temp comes to right slot
  tmux("swap-pane", "-s", state.activePaneId, "-t", tempPaneId);
  state.activePaneId = tempPaneId;
  state.activePaneType = null;
  state.activeWindowName = null;
  return tempPaneId;
}

/**
 * Restore content from a hidden window into the right slot.
 * The hidden window is killed afterward.
 */
export function restoreFromHidden(windowName: string, state: DashboardState): void {
  const targetPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (!targetPaneId || !state.activePaneId) return;

  tmux("swap-pane", "-s", state.activePaneId, "-t", targetPaneId);
  killWindowSafe(windowName);
  state.activePaneId = targetPaneId;
}

/**
 * Park current content and restore from another hidden window in one step.
 */
export function swapToHidden(parkWindowName: string, restoreWindowName: string, state: DashboardState): void {
  parkToHidden(parkWindowName, state);
  restoreFromHidden(restoreWindowName, state);
}
