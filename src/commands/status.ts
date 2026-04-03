// Shows project status: registered projects, active workers, and their states.
import { loadConfig, getFocusedProjectNames } from "../config.js";
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { output, isTTY } from "../output.js";
import { readDashState, type DashboardState } from "../dashboard/state.js";
import { getWorkers, batchUpdateWorkerFields } from "../dashboard/registry.js";
import {
  getPaneLabel, getFirstPaneId, listHiddenWorkerWindows,
} from "../dashboard/tmux.js";
import { detectPaneProcessStatus, type ProcessStatus, type PaneProcessInfo } from "../dashboard/detect.js";
type LifecycleStatus = "pushed" | "reviewing" | "merge-pending" | "failing" | "merged";
type WorkerStatus = ProcessStatus | LifecycleStatus;

interface WorkerInfo {
  name: string;
  status: WorkerStatus;         // display label: lifecycle state when present, else process state
  processStatus: ProcessStatus; // what Claude is doing right now (cached to registry)
  activity: string | null;
  active: boolean;
  mergeCount: number;
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
  pushed:         "\u2191",     // up arrow
  reviewing:      "\u25CE",     // bullseye
  "merge-pending": "\u25F7",    // circle with right half - queued
  failing:        "\u2716",     // heavy multiplication x
  merged:         "\u2713",     // check mark
  exited:         "\u25CB",     // open circle
};

function iconFor(worker: WorkerInfo): string {
  // Use the display status for the icon so lifecycle states (merged,
  // reviewing, etc.) show their own icon rather than a spinner when
  // the Claude process happens to still be detected as active.
  if (worker.status === "working") {
    const frame = Math.floor(Date.now() / 2000) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[frame];
  }
  return STATUS_ICONS[worker.status];
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

  const statuses: ProjectStatusInfo[] = names.map((name, i) => {
    return {
      name,
      index: i + 1,
      isActive: dashState.activeProject === name,
      workers: hasDashboard ? getProjectWorkers(name, dashState) : [],
    };
  });

  if (!isTTY) {
    output(statuses);
    return;
  }

  // Compute column widths across all workers
  const allWorkers = statuses.flatMap(p => p.workers);
  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = Math.max(7, ...allWorkers.map(w => formatStatus(w).length));

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
        const name = worker.name.padEnd(nameWidth);
        const status = formatStatus(worker).padEnd(statusWidth);
        const activity = worker.activity ? `  ${worker.activity}` : "";
        console.log(`    ${focus} ${icon} ${name}  ${status}${activity}`);
      }
    }
  }
  console.log("");
}

function formatStatus(worker: WorkerInfo): string {
  const base = worker.status;
  if (base === "merged" && worker.mergeCount > 1) return `merged (x${worker.mergeCount})`;
  if (base === "failing" && worker.failCount > 1) return `failing (x${worker.failCount})`;
  if (base === "merge-pending") return "merge pending";
  return base;
}

function resolveWorkerStatus(paneStatus: PaneProcessInfo["status"], regEntry: { prState?: string; task?: string } | undefined, activity: string | null): { status: WorkerStatus; processStatus: ProcessStatus } {
  const processStatus: ProcessStatus = (paneStatus === "ready" && activity) ? "idle" : paneStatus;
  const pr = regEntry?.prState;
  // When pushed but Claude is actively working, show "working" — the commits
  // are there but review is deferred until Claude finishes.
  if (pr === "pushed" && processStatus === "working") {
    return { status: "working", processStatus };
  }
  if (pr === "merged" || pr === "merge-pending" || pr === "reviewing" || pr === "pushed" || pr === "failing") {
    return { status: pr, processStatus };
  }
  return { status: processStatus, processStatus };
}

function getProjectWorkers(projectName: string, dashState: { activeProject: string | null; activePaneId: string | null; activePaneType: string | null; activeWindowName?: string | null }): WorkerInfo[] {
  const workers: WorkerInfo[] = [];
  const activeWindowName = dashState.activeWindowName ?? null;
  const registryEntries = getWorkers(projectName);
  const registryTaskByName = new Map(registryEntries.map(e => [e.name, e.task]));
  const registryByName = new Map(registryEntries.map(e => [e.name, e]));

  const statusUpdates: Array<[string, string]> = [];

  if (dashState.activeProject === projectName && dashState.activePaneId && dashState.activePaneType === "worker") {
    const label = getPaneLabel(dashState.activePaneId) ?? "worker-1";
    const paneInfo = detectPaneProcessStatus(dashState.activePaneId, projectName, label);
    if (!paneInfo.activity) paneInfo.activity = registryTaskByName.get(label) || null;
    const regEntry = registryByName.get(label);
    const resolved = resolveWorkerStatus(paneInfo.status, regEntry, paneInfo.activity);
    statusUpdates.push([label, resolved.processStatus]);
    workers.push({ name: label, ...resolved, activity: paneInfo.activity, active: true, mergeCount: regEntry?.mergeCount ?? 0, failCount: regEntry?.failCount ?? 0 });
  }

  const hiddenWindows = listHiddenWorkerWindows(projectName);
  for (const win of hiddenWindows) {
    if (win === activeWindowName) continue;
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${win}`);
    if (paneId) {
      const label = getPaneLabel(paneId) ?? win.replace(`_${projectName}-`, "");
      const paneInfo = detectPaneProcessStatus(paneId, projectName, label);
      if (!paneInfo.activity) paneInfo.activity = registryTaskByName.get(label) || null;
      const regEntry = registryByName.get(label);
      const resolved = resolveWorkerStatus(paneInfo.status, regEntry, paneInfo.activity);
      statusUpdates.push([label, resolved.processStatus]);
      workers.push({ name: label, ...resolved, activity: paneInfo.activity, active: false, mergeCount: regEntry?.mergeCount ?? 0, failCount: regEntry?.failCount ?? 0 });
    }
  }

  if (statusUpdates.length > 0) {
    try {
      batchUpdateWorkerFields(
        statusUpdates.map(([label, status]) => ({
          project: projectName, workerName: label, fields: { claudeStatus: status },
        })),
      );
    } catch { /* best effort */ }
  }

  // Include registry-only workers (e.g., merged workers whose windows are gone)
  const seenNames = new Set(workers.map(w => w.name));
  for (const entry of registryEntries) {
    if (!seenNames.has(entry.name) && entry.prState === "merged") {
      workers.push({
        name: entry.name,
        status: "merged",
        processStatus: "exited",
        activity: null,
        active: false,
        mergeCount: entry.mergeCount ?? 0,
        failCount: entry.failCount ?? 0,
      });
    }
  }

  workers.sort((a, b) => a.name.localeCompare(b.name));

  return workers;
}


/**
 * Render status from state + registry without any pgrep/tmux process detection.
 * Used for instant visual feedback on mutations; the full status poll refines it.
 */
export function renderQuickStatus(state: DashboardState, windowNames?: string[]): string {
  const config = loadConfig();
  const names = getFocusedProjectNames(config);
  if (names.length === 0) return "No projects added.";

  const lines: string[] = [];
  const allWorkers: WorkerInfo[] = [];

  const projectWorkers: WorkerInfo[][] = names.map((name) => {
    const workers = getQuickWorkers(name, state, windowNames);
    allWorkers.push(...workers);
    return workers;
  });

  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = Math.max(7, ...allWorkers.map(w => formatStatus(w).length));

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
        const wName = worker.name.padEnd(nameWidth);
        const wStatus = formatStatus(worker).padEnd(statusWidth);
        const activity = worker.activity ? `  ${worker.activity}` : "";
        lines.push(`    ${focus} ${icon} ${wName}  ${wStatus}${activity}`);
      }
    }
  }
  lines.push("");

  // Append clear-to-end-of-line to each line so the status pane can
  // overwrite in place without full screen clears (avoids flashing).
  return lines.map(l => l + "\x1b[K").join("\n");
}

function getQuickWorkers(projectName: string, state: DashboardState, windowNames?: string[]): WorkerInfo[] {
  const workers: WorkerInfo[] = [];
  const registryEntries = getWorkers(projectName);
  const registryByName = new Map(registryEntries.map(e => [e.name, e]));

  if (state.activeProject === projectName && state.activePaneType === "worker") {
    const nameMatch = (state.activeWindowName ?? "").match(/-worker-(.+)$/);
    const label = nameMatch ? nameMatch[1] : "worker-1";
    const entry = registryByName.get(label);
    const resolved = resolveQuickWorkerStatus(entry);
    workers.push({ name: label, ...resolved, activity: entry?.task ?? null, active: true, mergeCount: entry?.mergeCount ?? 0, failCount: entry?.failCount ?? 0 });
  }

  const hiddenWindows = listHiddenWorkerWindows(projectName, windowNames);
  for (const win of hiddenWindows) {
    if (win === state.activeWindowName) continue;
    const nameMatch = win.match(/-worker-(.+)$/);
    const label = nameMatch ? nameMatch[1] : win;
    const entry = registryByName.get(label);
    const resolved = resolveQuickWorkerStatus(entry);
    workers.push({ name: label, ...resolved, activity: entry?.task ?? null, active: false, mergeCount: entry?.mergeCount ?? 0, failCount: entry?.failCount ?? 0 });
  }

  const seenNames = new Set(workers.map(w => w.name));
  for (const entry of registryEntries) {
    if (!seenNames.has(entry.name) && entry.prState === "merged") {
      workers.push({ name: entry.name, status: "merged", processStatus: "exited", activity: null, active: false, mergeCount: entry.mergeCount ?? 0, failCount: entry.failCount ?? 0 });
    }
  }

  workers.sort((a, b) => a.name.localeCompare(b.name));
  return workers;
}

function resolveQuickWorkerStatus(entry?: { prState?: string; task?: string; claudeStatus?: string }): { status: WorkerStatus; processStatus: ProcessStatus } {
  // Process status: use cached pgrep result, fall back to task heuristic
  const cached = entry?.claudeStatus as ProcessStatus | undefined;
  const processStatus: ProcessStatus = cached ?? (entry?.task ? "idle" : "ready");

  const pr = entry?.prState;
  // When pushed but Claude is actively working, show "working" — the commits
  // are there but review is deferred until Claude finishes.
  if (pr === "pushed" && processStatus === "working") {
    return { status: "working", processStatus };
  }
  if (pr === "merged" || pr === "merge-pending" || pr === "reviewing" || pr === "pushed" || pr === "failing") {
    return { status: pr, processStatus };
  }
  return { status: processStatus, processStatus };
}

