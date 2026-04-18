// Dashboard state: tracks which project is active, which panes are where.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
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
  gardenShellPaneId: string | null; // current pane ID in the garden slot (despite the name)
  gardenPaneType: "garden" | "root" | "logs" | null;
  gardenWindowName: string | null; // logical name for parking, e.g. "_garden-root" or "_garden-logs"
  // Right side — activePaneId is the pane currently in the right slot
  activePaneId: string | null;
  activePaneType: "worker" | "shell" | null;
  activeWindowName: string | null; // logical name for parking, e.g. "_proj-shell" or "_proj-worker-2"
  // Per-project last-active worker window name (not persisted across sessions)
  lastActiveWorker: Record<string, string>;
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
};

export function readDashState(): DashboardState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    // Backfill new fields for state files from older versions
    // Migrate old view names
    if (raw.gardenPaneType === "console") raw.gardenPaneType = "garden";
    if (raw.gardenPaneType === "shell") raw.gardenPaneType = "root";
    if (raw.gardenPaneType === undefined) raw.gardenPaneType = "garden";
    if (raw.gardenPaneType === "root" && raw.gardenWindowName === null) raw.gardenPaneType = "garden";
    if (raw.gardenWindowName === "_garden-console") raw.gardenWindowName = "_garden-garden";
    if (raw.gardenWindowName === "_garden-shell") raw.gardenWindowName = "_garden-root";
    if (raw.gardenWindowName === undefined) raw.gardenWindowName = null;
    if (raw.usagePaneId === undefined) raw.usagePaneId = null;
    if (raw.activePlot === undefined) raw.activePlot = null;
    if (!raw.lastActiveWorker) raw.lastActiveWorker = {};
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
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmpFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}
