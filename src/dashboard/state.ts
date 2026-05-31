// Dashboard state: tracks which project is active, which panes are where.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import { log } from "./log.js";

const STATE_LOCK_FILE = path.join(SESSIONS_DIR, "dashboard.state.json.lock");

// Serialize concurrent read-modify-write cycles on the state file. Hotkey
// handlers run in separate short-lived processes via tmux run-shell and
// can collide on rapid keypresses — without this, two handlers reading
// stale state and writing back will silently lose the second update.
export function withStateLock<T>(fn: () => T): T {
  return withFileLock(STATE_LOCK_FILE, fn, { name: "state" });
}

export interface DashboardState {
  activeProject: string | null;
  activePlot: string | null;
  // Left side — garden pane is swappable between shell and logs
  statusPaneId: string | null;
  usagePaneId: string | null;
  gardenShellPaneId: string | null; // current pane ID in the growhouse slot (lower-left)
  gardenPaneType: "growhouse" | "root" | "logs" | "history" | null;
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

// Shape guard for parsed state. Runs AFTER the migration patches so legacy
// values that get healed (e.g. `gardenPaneType: "garden" → "growhouse"`)
// pass validation. Strict on shape; permissive on optional `Record<string,
// string>` fields where an empty/missing value is filled in by the
// migrations above. A failed check signals real corruption (hand-edit
// gone wrong, half-write that survived rename, or a forward-incompatible
// dashboard version on the same state file) — fall back to defaults.
function isDashboardState(x: unknown): x is DashboardState {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";
  const isRecord = (v: unknown): boolean =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  return (
    isStrOrNull(r.activeProject) &&
    isStrOrNull(r.activePlot) &&
    isStrOrNull(r.statusPaneId) &&
    isStrOrNull(r.usagePaneId) &&
    isStrOrNull(r.gardenShellPaneId) &&
    isStrOrNull(r.gardenPaneType) &&
    isStrOrNull(r.gardenWindowName) &&
    isStrOrNull(r.activePaneId) &&
    isStrOrNull(r.activePaneType) &&
    isStrOrNull(r.activeWindowName) &&
    isRecord(r.lastActiveWorker) &&
    isRecord(r.lastActiveProjectByPlot)
  );
}

// In-process cache: refreshDashboard / hook handlers / hotkey handlers all
// readDashState on every event. Cache the parsed value keyed on file stat
// (mtimeMs+size); skip the read+parse+migration walk when nothing changed
// on disk. Cross-process visibility is preserved — any external write
// changes mtime so the next read sees fresh content. Returns a fresh clone
// so callers can mutate freely (the read-modify-writeDashState pattern under
// withStateLock relies on that).
let cachedState: { mtimeMs: number; size: number; value: DashboardState } | null = null;

function invalidateStateCache(): void {
  cachedState = null;
}

export function readDashState(): DashboardState {
  try {
    const stat = fs.statSync(STATE_FILE);
    if (cachedState
        && cachedState.mtimeMs === stat.mtimeMs
        && cachedState.size === stat.size) {
      return structuredClone(cachedState.value);
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    if (raw.gardenPaneType === "garden") raw.gardenPaneType = "growhouse";
    if (raw.gardenPaneType === "console") raw.gardenPaneType = "growhouse";
    if (raw.gardenPaneType === undefined) raw.gardenPaneType = "growhouse";
    if (raw.gardenPaneType === "root" && raw.gardenWindowName === null) raw.gardenPaneType = "growhouse";
    if (raw.gardenWindowName === "_garden-garden") raw.gardenWindowName = "_garden-growhouse";
    if (raw.gardenWindowName === "_garden-console") raw.gardenWindowName = "_garden-growhouse";
    // The "conversation" view was renamed to "history" (⌥c → ⌥h).
    if (raw.gardenPaneType === "conversation") raw.gardenPaneType = "history";
    if (raw.gardenWindowName === "_garden-conversation") raw.gardenWindowName = "_garden-history";
    if (raw.gardenWindowName === undefined) raw.gardenWindowName = null;
    if (raw.usagePaneId === undefined) raw.usagePaneId = null;
    if (raw.activePlot === undefined) raw.activePlot = null;
    if (!raw.lastActiveWorker) raw.lastActiveWorker = {};
    if (!raw.lastActiveProjectByPlot) raw.lastActiveProjectByPlot = {};
    if (!isDashboardState(raw)) {
      log.warn("state", "state file failed shape check, using defaults", {
        data: { keys: Object.keys(raw ?? {}) },
      });
      return { ...DEFAULT_STATE };
    }
    cachedState = { mtimeMs: stat.mtimeMs, size: stat.size, value: raw };
    return structuredClone(raw);
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
  // Invalidate after write so the next readDashState picks up fresh state.
  // mtime changes anyway; explicit invalidation guards against sub-millisecond
  // mtime resolution clamping on some filesystems.
  invalidateStateCache();
}
