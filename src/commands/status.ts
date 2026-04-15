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
import { getWorkers, readRegistry, batchUpdateWorkerFields } from "../dashboard/registry.js";
import { listHiddenWorkerWindows, windowExists, getFirstPaneId, getPaneTitle } from "../dashboard/tmux.js";
import { workerWindowName as workerWin, parseWorkerSuffix } from "../dashboard/window-names.js";
import { renderUsageHeader } from "../dashboard/usage.js";

// Display states from STATUS.md. These are the only values the renderer ever
// emits. `loading`/`ready`/`working`/`idle`/`exited` come from claudeStatus
// (written by hooks). `reviewing`/`merge-pending`/`failing`/`merged` come
// from prState (written by the poller). The combine function gives prState
// priority because it describes where the worker's *code* is.
export type ProcessStatus = "loading" | "ready" | "working" | "idle" | "exited";
type LifecycleStatus = "reviewing" | "merge-pending" | "resolving" | "failing" | "merged";
type WorkerStatus = ProcessStatus | LifecycleStatus;

interface WorkerInfo {
  name: string;
  status: WorkerStatus;
  activity: string | null;
  active: boolean;
  failCount: number;
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
  idle:           "\u25C6",     // filled diamond
  reviewing:      "\u25CE",     // bullseye
  "merge-pending": "\u25F7",    // circle with right half - queued
  resolving:      "\u25D4",     // circle with upper-right quadrant - resolving
  failing:        "\u2716",     // heavy multiplication x
  merged:         "\u2713",     // check mark
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
  const names = getFocusedProjectNames(config);

  if (names.length === 0) {
    console.log("No projects added.");
    return;
  }

  const dashState = readDashState();
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

  console.log(renderUsageHeader());
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
        const activity = worker.activity ? `  ${truncateActivity(worker.activity, activityMax)}` : "";
        console.log(`    ${focus} ${icon} ${wname}  ${wstatus}${activity}`);
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

// Combine claudeStatus and prState into a single display state.
// Lifecycle states (reviewing, merge-pending, failing, merged) take priority
// because they describe where the worker's *code* is, not what Claude is
// doing right now. The hook handler is the only place that clears `merged`
// from prState (on UserPromptSubmit) — this function never mutates state.
export function resolveWorkerStatus(
  entry: { claudeStatus?: string; prState?: string } | undefined,
): WorkerStatus {
  const pr = entry?.prState;
  if (pr === "reviewing" || pr === "merge-pending" || pr === "resolving" || pr === "failing" || pr === "merged") {
    return pr;
  }
  const cs = entry?.claudeStatus as ProcessStatus | undefined;
  // No claudeStatus yet (e.g., entry just created without "loading"): show
  // "ready" as the safest neutral state.
  return cs ?? "ready";
}

function collectWorkers(
  projectName: string,
  state: DashboardState,
  windowNames?: string[],
): WorkerInfo[] {
  const workers: WorkerInfo[] = [];
  const registryEntries = getWorkers(projectName);
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
export function renderQuickStatus(state: DashboardState, windowNames?: string[]): string {
  const config = loadConfig();
  const names = getFocusedProjectNames(config);
  if (names.length === 0) return "No projects added.";

  const lines: string[] = [];
  const allWorkers: WorkerInfo[] = [];

  const projectWorkers: WorkerInfo[][] = names.map((name) => {
    const workers = collectWorkers(name, state, windowNames);
    allWorkers.push(...workers);
    return workers;
  });

  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = STATUS_WIDTH;

  // Prepend the Claude usage header before the project/worker list. The
  // helper handles loading/error/stale variants and already clears to EOL.
  lines.push(...renderUsageHeader().split("\n"));
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
        const activity = worker.activity ? `  ${worker.activity}` : "";
        lines.push(`    ${focus} ${icon} ${wname}  ${wstatus}${activity}`);
      }
    }
  }
  lines.push("");

  // Append clear-to-end-of-line to each line so the status pane can
  // overwrite in place without full screen clears (avoids flashing).
  return lines.map(l => l + "\x1b[K").join("\n");
}
