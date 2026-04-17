// Pane parking and restoring: swaps content between the visible right slot
// and hidden tmux windows so the layout tree is never modified.
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxNewWindow, getFirstPaneId, killWindowSafe, renameWindow, paneExists, getPaneSize, resizeWindow } from "./tmux.js";
import type { DashboardState } from "./state.js";
import { log } from "./log.js";

/**
 * Park the visible right pane's content into a hidden window.
 * After this, the right slot contains a temporary empty shell.
 * Returns the temp pane ID now in the right slot.
 */
export function parkToHidden(windowName: string, state: DashboardState): string | null {
  if (!state.activePaneId || !paneExists(state.activePaneId)) {
    log.warn("layout", "parkToHidden: active pane missing or dead");
    return null;
  }

  const visibleSize = getPaneSize(state.activePaneId);

  killWindowSafe(windowName);

  const tempPaneId = tmuxNewWindow("-d", "-t", DASHBOARD_SESSION, "-n", windowName);
  if (!tempPaneId) {
    log.error("layout", "parkToHidden: failed to get pane ID for new window");
    return null;
  }

  // Pre-size the hidden window to match the visible slot so swap-pane
  // does not trigger a SIGWINCH reflow on the content being parked.
  if (visibleSize) {
    resizeWindow(windowName, visibleSize.width, visibleSize.height);
  }

  // Swap: active content goes to hidden window, temp comes to right slot
  tmux("swap-pane", "-s", state.activePaneId, "-t", tempPaneId);
  log.debug("layout", "parked to hidden", { data: { windowName } });
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
  if (!targetPaneId || !state.activePaneId) {
    log.warn("layout", "restoreFromHidden: missing pane");
    return;
  }

  // Pre-size the hidden window to match the visible slot so swap-pane
  // does not trigger a SIGWINCH reflow on the content being restored.
  const visibleSize = getPaneSize(state.activePaneId);
  if (visibleSize) {
    resizeWindow(windowName, visibleSize.width, visibleSize.height);
  }

  tmux("swap-pane", "-s", state.activePaneId, "-t", targetPaneId);
  killWindowSafe(windowName);
  log.debug("layout", "restored from hidden", { data: { windowName } });
  state.activePaneId = targetPaneId;
}

/**
 * Park current content and restore from another hidden window in one step.
 */
export function swapToHidden(parkWindowName: string, restoreWindowName: string, state: DashboardState): void {
  parkToHidden(parkWindowName, state);
  restoreFromHidden(restoreWindowName, state);
}

/**
 * Fast swap: directly exchange visible pane with a hidden window's pane,
 * then rename the hidden window. Avoids creating/destroying temp windows.
 * Use when both source (visible) and target (hidden) are known to exist.
 * Returns true on success, false on failure (caller should fall back to swapToHidden).
 */
export function swapDirect(parkWindowName: string, restoreWindowName: string, state: DashboardState): boolean {
  if (!state.activePaneId || !paneExists(state.activePaneId)) {
    log.warn("layout", "swapDirect: active pane missing or dead");
    return false;
  }

  const targetPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${restoreWindowName}`);
  if (!targetPaneId) {
    log.warn("layout", "swapDirect: target window missing");
    return false;
  }

  // Pre-size the hidden window to match the visible slot so swap-pane
  // does not trigger a SIGWINCH reflow on either pane.
  const visibleSize = getPaneSize(state.activePaneId);
  if (visibleSize) {
    resizeWindow(restoreWindowName, visibleSize.width, visibleSize.height);
  }

  // Direct swap: visible content goes to hidden window, hidden content comes to visible slot
  tmux("swap-pane", "-s", state.activePaneId, "-t", targetPaneId);
  // Rename the hidden window (now holding old visible content) to the park name
  renameWindow(restoreWindowName, parkWindowName);

  log.debug("layout", "swapDirect", { data: { from: parkWindowName, to: restoreWindowName } });
  state.activePaneId = targetPaneId;
  return true;
}

/**
 * Park the garden pane's content into a hidden window.
 * After this, the garden slot contains a temporary empty shell.
 */
export function gardenParkToHidden(windowName: string, state: DashboardState): string | null {
  if (!state.gardenShellPaneId || !paneExists(state.gardenShellPaneId)) {
    log.warn("layout", "gardenParkToHidden: garden pane missing or dead");
    return null;
  }

  const visibleSize = getPaneSize(state.gardenShellPaneId);

  killWindowSafe(windowName);

  const tempPaneId = tmuxNewWindow("-d", "-t", DASHBOARD_SESSION, "-n", windowName);
  if (!tempPaneId) {
    log.error("layout", "gardenParkToHidden: failed to get pane ID for new window");
    return null;
  }

  if (visibleSize) {
    resizeWindow(windowName, visibleSize.width, visibleSize.height);
  }

  tmux("swap-pane", "-s", state.gardenShellPaneId, "-t", tempPaneId);
  log.debug("layout", "garden parked", { data: { windowName } });
  state.gardenShellPaneId = tempPaneId;
  state.gardenPaneType = null;
  state.gardenWindowName = null;
  return tempPaneId;
}

/**
 * Restore content from a hidden window into the garden slot.
 * The hidden window is killed afterward.
 */
export function gardenRestoreFromHidden(windowName: string, state: DashboardState): void {
  const targetPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (!targetPaneId || !state.gardenShellPaneId) {
    log.warn("layout", "gardenRestoreFromHidden: missing pane");
    return;
  }

  const visibleSize = getPaneSize(state.gardenShellPaneId);
  if (visibleSize) {
    resizeWindow(windowName, visibleSize.width, visibleSize.height);
  }

  tmux("swap-pane", "-s", state.gardenShellPaneId, "-t", targetPaneId);
  killWindowSafe(windowName);
  log.debug("layout", "garden restored", { data: { windowName } });
  state.gardenShellPaneId = targetPaneId;
}

/**
 * Park current garden content and restore from another hidden window in one step.
 */
export function gardenSwapToHidden(parkWindowName: string, restoreWindowName: string, state: DashboardState): void {
  gardenParkToHidden(parkWindowName, state);
  gardenRestoreFromHidden(restoreWindowName, state);
}
