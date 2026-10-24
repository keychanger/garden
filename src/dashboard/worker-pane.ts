// Finding a worker's pane, for every caller that pastes a prompt into it,
// reads its title or screen, or sends it a key. One function, because the
// copies drifted: one of them trusted the recorded slot without asking tmux.
//
// The per-tool-call hook (hooks/default.ts) reaches it, so it imports only
// modules that bundle already holds.
import { DASHBOARD_SESSION } from "../session.js";
import { readDashState } from "./state.js";
import { getFirstPaneId, paneExists, windowExists } from "./tmux.js";
import { workerWindowName } from "./window-names.js";

// A worker in the right slot has no hidden window of its own (swapping it in
// killed or renamed that window), so the slot's pane id in dashboard state is
// the only way to it. That id is a record, not tmux, so it is used only while
// tmux still has the pane; a slot whose pane died falls through to the hidden
// window rather than handing back a dead id. Null when neither holds the
// worker, including when tmux does not answer.
export function resolveWorkerPaneId(project: string, worker: string): string | null {
  const windowName = workerWindowName(project, worker);
  const state = readDashState();
  if (state.activeWindowName === windowName && state.activePaneId
      && paneExists(state.activePaneId)) {
    return state.activePaneId;
  }
  if (windowExists(windowName)) {
    return getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  }
  return null;
}
