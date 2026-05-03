// Dashboard state: tracks which project is active, which panes are where.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";

const STATE_LOCK_FILE = path.join(SESSIONS_DIR, "dashboard.state.json.lock");

// Serialize concurrent read-modify-write cycles on the state file using the
// same O_CREAT|O_EXCL file lock pattern as the registry. Hotkey handlers run
// in separate short-lived processes via tmux run-shell and can collide on
// rapid keypresses — without this, two handlers reading stale state and
// writing back will silently lose the second update.
export function withStateLock<T>(fn: () => T): T {
  const deadline = Date.now() + 500;
  const myPid = process.pid;
  let acquired = false;

  while (!acquired && Date.now() < deadline) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const fd = fs.openSync(STATE_LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      fs.writeSync(fd, String(myPid));
      fs.closeSync(fd);
      acquired = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        let holderPid = -1;
        try { holderPid = parseInt(fs.readFileSync(STATE_LOCK_FILE, "utf-8"), 10); } catch { /* ignore */ }
        let holderAlive = false;
        if (Number.isFinite(holderPid) && holderPid > 0) {
          try { process.kill(holderPid, 0); holderAlive = true; } catch { /* dead */ }
        }
        if (!holderAlive) {
          try { fs.unlinkSync(STATE_LOCK_FILE); } catch { /* ignore */ }
          continue;
        }
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, 5);
        continue;
      }
      throw err;
    }
  }

  if (!acquired) {
    throw new Error("Could not acquire state lock after 500ms");
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(STATE_LOCK_FILE); } catch { /* ignore */ }
  }
}

export interface DashboardState {
  activeProject: string | null;
  activePlot: string | null;
  // Left side — garden pane is swappable between shell and logs
  statusPaneId: string | null;
  usagePaneId: string | null;
  gardenShellPaneId: string | null; // current pane ID in the growhouse slot (lower-left)
  gardenPaneType: "growhouse" | "root" | "logs" | null;
  gardenWindowName: string | null; // logical name for parking, e.g. "_garden-growhouse" or "_garden-logs"
  // Right side — activePaneId is the pane currently in the right slot
  activePaneId: string | null;
  activePaneType: "worker" | "shell" | null;
  activeWindowName: string | null; // logical name for parking, e.g. "_proj-shell" or "_proj-worker-2"
  // Per-project last-active worker window name (not persisted across sessions)
  lastActiveWorker: Record<string, string>;
  // Per-plot last-active project — lets ⌥p restore the prior selection when
  // cycling back to a plot, rather than always clamping to the first project.
  lastActiveProjectByPlot: Record<string, string>;
}

export const STATE_FILE = path.join(SESSIONS_DIR, "dashboard.state.json");

const DEFAULT_STATE: DashboardState = {
  activeProject: null,
  activePlot: null,
  statusPaneId: null,
  usagePaneId: null,
  gardenShellPaneId: null,
  gardenPaneType: null,
  gardenWindowName: null,
  activePaneId: null,
  activePaneType: null,
  activeWindowName: null,
  lastActiveWorker: {},
  lastActiveProjectByPlot: {},
};

export function readDashState(): DashboardState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    if (raw.gardenPaneType === "garden") raw.gardenPaneType = "growhouse";
    if (raw.gardenPaneType === "console") raw.gardenPaneType = "growhouse";
    if (raw.gardenPaneType === undefined) raw.gardenPaneType = "growhouse";
    if (raw.gardenPaneType === "root" && raw.gardenWindowName === null) raw.gardenPaneType = "growhouse";
    if (raw.gardenWindowName === "_garden-garden") raw.gardenWindowName = "_garden-growhouse";
    if (raw.gardenWindowName === "_garden-console") raw.gardenWindowName = "_garden-growhouse";
    if (raw.gardenWindowName === undefined) raw.gardenWindowName = null;
    if (raw.usagePaneId === undefined) raw.usagePaneId = null;
    if (raw.activePlot === undefined) raw.activePlot = null;
    if (!raw.lastActiveWorker) raw.lastActiveWorker = {};
    if (!raw.lastActiveProjectByPlot) raw.lastActiveProjectByPlot = {};
    return raw;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("state", "failed to read state file, using defaults", {
        data: { error: String(err) },
      });
    }
  }
  return { ...DEFAULT_STATE };
}

export function writeDashState(state: DashboardState): void {
  atomicWriteFile(STATE_FILE, JSON.stringify(state, null, 2));
}
