// Dashboard state: tracks which project is active, which panes are where.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { log } from "./log.js";

export interface DashboardState {
  activeProject: string | null;
  // Left side (fixed)
  statusPaneId: string | null;
  gardenShellPaneId: string | null;
  // Right side — activePaneId is the pane currently in the right slot
  activePaneId: string | null;
  activePaneType: "worker" | "shell" | null;
  activeWindowName: string | null; // logical name for parking, e.g. "_proj-shell" or "_proj-worker-2"
}

export const STATE_FILE = path.join(SESSIONS_DIR, "dashboard.state.json");

const DEFAULT_STATE: DashboardState = {
  activeProject: null,
  statusPaneId: null,
  gardenShellPaneId: null,
  activePaneId: null,
  activePaneType: null,
  activeWindowName: null,
};

export function readDashState(): DashboardState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (err) {
    log.warn("state", "failed to read state file, using defaults", {
      file: STATE_FILE,
      error: String(err),
    });
  }
  return { ...DEFAULT_STATE };
}

export function writeDashState(state: DashboardState): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmpFile = STATE_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}
