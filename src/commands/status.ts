// Shows project status: registered projects, active workers, and their states.
//
// Per STATUS.md, the registry is the single source of truth and there is one
// render path. This file reads claudeStatus and prState from the registry,
// combines them via resolveWorkerStatus(), and renders. It does not call
// pgrep and does not read marker files. Before rendering, it refreshes
// worker task summaries from live tmux pane titles so the registry stays
// current between hook events.
import { loadConfig, getFocusedProjectNames } from "../config.js";
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { output, isTTY } from "../output.js";
import { readDashState, type DashboardState } from "../dashboard/state.js";
import { getWorkers, readRegistry, batchUpdateWorkerFields, type WorkerRegistry } from "../dashboard/registry.js";
import { listHiddenWorkerWindows, windowExists, getFirstPaneId, getPaneTitle } from "../dashboard/tmux.js";
import { workerWindowName as workerWin, parseWorkerSuffix } from "../dashboard/window-names.js";

// Display states from STATUS.md. These are the only values the renderer ever
// emits. `loading`/`ready`/`working`/`idle`/`exited` come from claudeStatus
// (written by hooks). `reviewing`/`merge-pending`/`failing`/`merged`/`done`
// come from prState (written by the poller and the Stop hook). The combine
// function gives prState priority because it describes where the worker's
// *code* is.
export type ProcessStatus = "loading" | "ready" | "working" | "asking" | "idle" | "exited";
type LifecycleStatus = "reviewing" | "merge-pending" | "resolving" | "failing" | "merged" | "done";
type WorkerStatus = ProcessStatus | LifecycleStatus;

interface WorkerInfo {
  name: string;
  status: WorkerStatus;
  activity: string | null;
  active: boolean;
  failCount: number;
  // Trellis-specific decoration fields. Populated only when
  // entry.workflow === "trellis"; default workers leave them undefined
  // and the renderer omits the bracket.
  trellis?: {
    name: string;
    iteration: number;
    maxIterations: number;
    driftCount: number;
    aligned: boolean;
    failingReason?: string;
  };
}

interface ProjectStatusInfo {
  name: string;
  index: number;
  isActive: boolean;
  workers: WorkerInfo[];
}

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const STATUS_ICONS: Record<WorkerStatus, string> = {
  loading:        "\u29D7",     // hourglass
  ready:          "\u25C7",     // open diamond
  working:        SPINNER_FRAMES[0],
  asking:         "\u2691",     // black flag — worker is blocked on operator input
  idle:           "\u25C6",     // filled diamond
  reviewing:      "\u25CE",     // bullseye
  "merge-pending": "\u25F7",    // circle with right half - queued
  resolving:      "\u25D4",     // circle with upper-right quadrant - resolving
  failing:        "\u2716",     // heavy multiplication x
  merged:         "\u2713",     // check mark - transient post-merge beat (neutral color)
  done:           "\u2713",     // check mark - operator-actionable cleanup signal (bold green)
  exited:         "\u25CB",     // open circle
};

function iconFor(worker: WorkerInfo): string {
  if (worker.status === "working") {
    const frame = Math.floor(Date.now() / 2000) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[frame];
  }
  return STATUS_ICONS[worker.status];
}

// Refresh all workers' task fields from their live tmux pane titles. Called
// before rendering so the registry has current data even if no hook has fired
// recently (e.g. workers in the middle of a long work session). This keeps
// the registry as the source of truth — we update it, then render from it.
function refreshWorkerTasks(state: DashboardState): void {
  try {
    const registry = readRegistry();
    const updates: Array<{ project: string; workerName: string; fields: { task: string } }> = [];

    for (const [project, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        const windowName = workerWin(project, entry.name);
        let paneId: string | null = null;
        if (state.activeWindowName === windowName && state.activePaneId) {
          paneId = state.activePaneId;
        } else if (windowExists(windowName)) {
          paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
        }
        if (!paneId) continue;
        const title = getPaneTitle(paneId);
        if (title && title !== entry.task) {
          updates.push({ project, workerName: entry.name, fields: { task: title } });
        }
      }
    }

    if (updates.length > 0) batchUpdateWorkerFields(updates);
  } catch { /* best effort */ }
}

export async function status(_args: string[]): Promise<void> {
  const config = loadConfig();
  const dashState = readDashState();
  const names = getFocusedProjectNames(config, dashState.activePlot);

  if (names.length === 0) {
    console.log("No projects added.");
    return;
  }
  const hasDashboard = dashboardExists();

  if (hasDashboard) refreshWorkerTasks(dashState);

  const statuses: ProjectStatusInfo[] = names.map((name, i) => {
    return {
      name,
      index: i + 1,
      isActive: dashState.activeProject === name,
      workers: hasDashboard ? collectWorkers(name, dashState) : [],
    };
  });

  if (!isTTY) {
    output(statuses);
    return;
  }

  const allWorkers = statuses.flatMap(p => p.workers);
  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = STATUS_WIDTH;
  const cols = process.stdout.columns || 120;
  const activityMax = Math.max(20, cols - (8 + nameWidth + 2 + statusWidth + 2));

  console.log("");
  for (let pi = 0; pi < statuses.length; pi++) {
    if (pi > 0) console.log("");
    const project = statuses[pi];
    const marker = project.isActive ? " \u25C4" : "";
    const name = project.isActive ? `\x1b[1;32m${project.name}\x1b[0m` : project.name;
    console.log(`  ${project.index}. ${name}${marker}`);

    if (project.workers.length === 0) {
      console.log("    (no workers)");
    } else {
      for (const worker of project.workers) {
        const focus = worker.active ? "\u25CF" : "\u25CB";
        const icon = iconFor(worker);
        const wname = worker.name.padEnd(nameWidth);
        const wstatus = formatStatus(worker).padEnd(statusWidth);
        const trellis = formatTrellisBracket(worker.trellis);
        const activity = worker.activity ? `  ${truncateActivity(worker.activity, activityMax)}` : "";
        const line = `    ${focus} ${icon} ${wname}  ${wstatus}${trellis}${activity}`;
        console.log(colorizeRow(worker.status, line));
      }
    }
  }
  console.log("");
}

function truncateActivity(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

const STATUS_WIDTH = 9; // "resolving" / "reviewing" are the widest

function formatStatus(worker: WorkerInfo): string {
  if (worker.status === "merge-pending") return "merging";
  return worker.status;
}

function colorizeRow(status: WorkerStatus, line: string): string {
  if (status === "asking") return `\x1b[1;33m${line}\x1b[0m`;
  if (status === "failing") return `\x1b[1;31m${line}\x1b[0m`;
  if (status === "done") return `\x1b[1;32m${line}\x1b[0m`;
  return line;
}

// Combine claudeStatus and prState into a single display state.
// Lifecycle states (reviewing, merge-pending, failing, merged, done) take
// priority because they describe where the worker's *code* is, not what
// Claude is doing right now. The hook handler is the only place that clears
// `merged`/`done` from prState (on UserPromptSubmit) — this function never
// mutates state.
export function resolveWorkerStatus(
  entry: { claudeStatus?: string; prState?: string } | undefined,
): WorkerStatus {
  const pr = entry?.prState;
  if (pr === "reviewing" || pr === "merge-pending" || pr === "resolving" || pr === "failing" || pr === "merged" || pr === "done") {
    return pr;
  }
  const cs = entry?.claudeStatus as ProcessStatus | undefined;
  // No claudeStatus yet (e.g., entry just created without "loading"): show
  // "ready" as the safest neutral state.
  return cs ?? "ready";
}

// Distill the trellis fields off a registry entry into the WorkerInfo
// shape used by the renderer. Returns undefined for default-workflow
// workers — the bracket is omitted.
function trellisInfoFor(entry?: { workflow?: string; trellis?: { name: string; iteration?: number; maxIterations?: number; lastDrift?: string[]; lastVerdict?: string; aligned?: boolean }; failingReason?: string }): WorkerInfo["trellis"] {
  if (!entry || entry.workflow !== "trellis") return undefined;
  const t = entry.trellis;
  return {
    name: t?.name ?? "?",
    iteration: t?.iteration ?? 0,
    maxIterations: t?.maxIterations ?? 30,
    driftCount: t?.lastVerdict === "DRIFT" ? (t.lastDrift?.length ?? 0) : 0,
    aligned: t?.aligned === true,
    failingReason: entry.failingReason,
  };
}

// Format the trellis bracket for a vine row. Layout per WORKFLOWS.md
// "Worker row":
//   Active vine, drifting:   [trellis: auth-rewrite | 4/30 | 3 drift]
//   Aligned terminal:        [trellis: auth-rewrite | ✓ aligned, 7 iters]
//   Flagged:                 [trellis: auth-rewrite | flagged]
//   Budget exhausted:        [trellis: auth-rewrite | budget exhausted]
//   Stagnated (v1.5):        [trellis: auth-rewrite | stagnated]
// Iteration counter color: white normally, yellow at ≥80% of cap,
// red at ≥95%.
export function formatTrellisBracket(t: WorkerInfo["trellis"]): string {
  if (!t) return "";
  // Failed states: prefer the failure reason over the iteration counter.
  if (t.failingReason === "trellis-flagged") {
    return ` [trellis: ${t.name} | flagged]`;
  }
  if (t.failingReason === "iteration-budget") {
    return ` [trellis: ${t.name} | budget exhausted]`;
  }
  if (t.failingReason === "stagnation") {
    return ` [trellis: ${t.name} | stagnated]`;
  }
  // Aligned terminal: distinguish reviewer-declared success from operator
  // sentinel-set with a check decoration + iteration count.
  if (t.aligned) {
    const noun = t.iteration === 1 ? "iter" : "iters";
    return ` [trellis: ${t.name} | ✓ aligned, ${t.iteration} ${noun}]`;
  }
  // Active loop. Iteration counter with color thresholds.
  const iterStr = colorizeIteration(t.iteration, t.maxIterations);
  const driftSeg = t.driftCount > 0 ? ` | ${t.driftCount} drift` : "";
  return ` [trellis: ${t.name} | ${iterStr}${driftSeg}]`;
}

function colorizeIteration(iter: number, max: number): string {
  const ratio = max > 0 ? iter / max : 0;
  const text = `${iter}/${max}`;
  if (ratio >= 0.95) return `\x1b[31m${text}\x1b[0m`;   // red
  if (ratio >= 0.80) return `\x1b[33m${text}\x1b[0m`;   // yellow
  return text;                                          // default
}

function collectWorkers(
  projectName: string,
  state: DashboardState,
  windowNames?: string[],
  cachedRegistry?: WorkerRegistry,
): WorkerInfo[] {
  const workers: WorkerInfo[] = [];
  // When a cache is provided, missing project key means "no workers" — don't
  // fall back to getWorkers(): that re-reads the registry and defeats the
  // cache for every plot project without a worker entry.
  const registryEntries = cachedRegistry
    ? (cachedRegistry.workers[projectName] ?? [])
    : getWorkers(projectName);
  const registryByName = new Map(registryEntries.map(e => [e.name, e]));

  if (state.activeProject === projectName && state.activePaneType === "worker") {
    const label = parseWorkerSuffix(state.activeWindowName ?? "") ?? "worker-1";
    const entry = registryByName.get(label);
    workers.push({
      name: label,
      status: resolveWorkerStatus(entry),
      activity: entry?.task || null,
      active: true,
      failCount: entry?.failCount ?? 0,
      trellis: trellisInfoFor(entry),
    });
  }

  const hiddenWindows = listHiddenWorkerWindows(projectName, windowNames);
  for (const win of hiddenWindows) {
    if (win === state.activeWindowName) continue;
    const label = parseWorkerSuffix(win) ?? win;
    const entry = registryByName.get(label);
    workers.push({
      name: label,
      status: resolveWorkerStatus(entry),
      activity: entry?.task || null,
      active: false,
      failCount: entry?.failCount ?? 0,
      trellis: trellisInfoFor(entry),
    });
  }

  workers.sort((a, b) => a.name.localeCompare(b.name));
  return workers;
}

/**
 * Render status from state + registry. Used by writeQuickStatus() to bake
 * the status pane content to a file before SIGUSR1, and reused by `garden
 * status` directly. There is one render path.
 */
export function renderQuickStatus(
  state: DashboardState,
  windowNames?: string[],
  cachedConfig?: ReturnType<typeof loadConfig>,
  cachedRegistry?: WorkerRegistry,
): string {
  const config = cachedConfig ?? loadConfig();
  const names = getFocusedProjectNames(config, state.activePlot);
  if (names.length === 0) return "No projects added.";

  const lines: string[] = [];
  const allWorkers: WorkerInfo[] = [];

  const projectWorkers: WorkerInfo[][] = names.map((name) => {
    const workers = collectWorkers(name, state, windowNames, cachedRegistry);
    allWorkers.push(...workers);
    return workers;
  });

  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = STATUS_WIDTH;

  lines.push("");
  for (let pi = 0; pi < names.length; pi++) {
    if (pi > 0) lines.push("");
    const name = names[pi];
    const isActive = state.activeProject === name;
    const marker = isActive ? " \u25C4" : "";
    const displayName = isActive ? `\x1b[1;32m${name}\x1b[0m` : name;
    lines.push(`  ${pi + 1}. ${displayName}${marker}`);

    const workers = projectWorkers[pi];
    if (workers.length === 0) {
      lines.push("    (no workers)");
    } else {
      for (const worker of workers) {
        const focus = worker.active ? "\u25CF" : "\u25CB";
        const icon = iconFor(worker);
        const wname = worker.name.padEnd(nameWidth);
        const wstatus = formatStatus(worker).padEnd(statusWidth);
        const trellis = formatTrellisBracket(worker.trellis);
        const activity = worker.activity ? `  ${worker.activity}` : "";
        const line = `    ${focus} ${icon} ${wname}  ${wstatus}${trellis}${activity}`;
        lines.push(colorizeRow(worker.status, line));
      }
    }
  }
  lines.push("");

  // Append clear-to-end-of-line to each line so the status pane can
  // overwrite in place without full screen clears (avoids flashing).
  return lines.map(l => l + "\x1b[K").join("\n");
}
