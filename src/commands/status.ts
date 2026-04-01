// Shows project status: registered projects, active workers, and their states.
import { loadConfig } from "../config.js";
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { output, isTTY } from "../output.js";
import { readDashState } from "../dashboard/state.js";
import { getWorkers } from "../dashboard/registry.js";
import {
  getPanePid, getPaneLabel, getPaneVar, getPaneTitle, getFirstPaneId,
  getClaudeChildPid, hasChildProcesses, listHiddenWorkerWindows,
} from "../dashboard/tmux.js";

type WorkerStatus = "ready" | "working" | "waiting" | "pushed" | "reviewing" | "merge-pending" | "failing" | "merged" | "exited";

interface WorkerInfo {
  name: string;
  status: WorkerStatus;
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

const WORKING_FRAMES = ["\u{1F331}", "\u{1FAB4}", "\u{1F33F}"];  // seedling, potted plant, herb
const STATUS_ICONS: Record<WorkerStatus, string> = {
  ready:          "\u{1FAB4}",  // potted plant (new, not yet tasked)
  working:        WORKING_FRAMES[0],
  waiting:        "\u{1F33F}",  // herb (needs input)
  pushed:         "\u{1F4E6}",  // package (shipped, awaiting review)
  reviewing:      "\u{1F338}",  // cherry blossom
  "merge-pending": "\u{1F338}", // cherry blossom (in merge queue)
  failing:        "\u{1F342}",  // fallen leaf
  merged:         "\u{1F333}",  // deciduous tree
  exited:         "\u{1F940}",  // wilted flower
};

function workingIcon(): string {
  const frame = Math.floor(Date.now() / 5000) % WORKING_FRAMES.length;
  return WORKING_FRAMES[frame];
}

function iconFor(status: WorkerStatus): string {
  if (status === "working") return workingIcon();
  return STATUS_ICONS[status];
}

export async function status(_args: string[]): Promise<void> {
  const config = loadConfig();
  const names = Object.keys(config.projects);

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

  for (let pi = 0; pi < statuses.length; pi++) {
    if (pi > 0) console.log();
    const project = statuses[pi];
    const marker = project.isActive ? " \u25C4" : "";
    const name = project.isActive ? `\x1b[1;32m${project.name}\x1b[0m` : project.name;
    console.log(`  ${project.index}. ${name}${marker}`);

    if (project.workers.length === 0) {
      console.log("    (no workers)");
    } else {
      for (const worker of project.workers) {
        const focus = worker.active ? "\u25CF" : "\u25CB";
        const icon = iconFor(worker.status);
        const name = worker.name.padEnd(nameWidth);
        const status = formatStatus(worker).padEnd(statusWidth);
        const activity = worker.activity ? `  ${worker.activity}` : "";
        console.log(`    ${focus} ${icon} ${name}  ${status}${activity}`);
      }
    }
  }
}

function formatStatus(worker: WorkerInfo): string {
  const base = worker.status;
  if (base === "merged" && worker.mergeCount > 1) return `merged (x${worker.mergeCount})`;
  if (base === "failing" && worker.failCount > 1) return `failing (x${worker.failCount})`;
  if (base === "merge-pending") return "merge pending";
  return base;
}

function resolveWorkerStatus(paneStatus: PaneInfo["status"], regEntry: { prState?: string; task?: string } | undefined, activity: string | null): WorkerStatus {
  const pr = regEntry?.prState;
  if (pr === "merged") return "merged";
  if (pr === "merge-pending") return "merge-pending";
  if (pr === "reviewing") return "reviewing";
  if (pr === "pushed") return "pushed";
  if (pr === "failing") return "failing";
  // Upgrade ready to waiting if we know this worker has a task
  if (paneStatus === "ready" && activity) return "waiting";
  return paneStatus;
}

function getProjectWorkers(projectName: string, dashState: { activeProject: string | null; activePaneId: string | null; activePaneType: string | null; activeWindowName?: string | null }): WorkerInfo[] {
  const workers: WorkerInfo[] = [];
  const activeWindowName = dashState.activeWindowName ?? null;
  const registryEntries = getWorkers(projectName);
  const registryTaskByName = new Map(registryEntries.map(e => [e.name, e.task]));
  const registryByName = new Map(registryEntries.map(e => [e.name, e]));

  if (dashState.activeProject === projectName && dashState.activePaneId && dashState.activePaneType === "worker") {
    const label = getPaneLabel(dashState.activePaneId) ?? "worker-1";
    const paneInfo = detectPaneProcessStatus(dashState.activePaneId);
    if (!paneInfo.activity) paneInfo.activity = registryTaskByName.get(label) || null;
    const regEntry = registryByName.get(label);
    const workerStatus = resolveWorkerStatus(paneInfo.status, regEntry, paneInfo.activity);
    workers.push({ name: label, status: workerStatus, activity: paneInfo.activity, active: true, mergeCount: regEntry?.mergeCount ?? 0, failCount: regEntry?.failCount ?? 0 });
  }

  const hiddenWindows = listHiddenWorkerWindows(projectName);
  for (const win of hiddenWindows) {
    if (win === activeWindowName) continue;
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${win}`);
    if (paneId) {
      const label = getPaneLabel(paneId) ?? win.replace(`_${projectName}-`, "");
      const paneInfo = detectPaneProcessStatus(paneId);
      if (!paneInfo.activity) paneInfo.activity = registryTaskByName.get(label) || null;
      const regEntry = registryByName.get(label);
      const workerStatus = resolveWorkerStatus(paneInfo.status, regEntry, paneInfo.activity);
      workers.push({ name: label, status: workerStatus, activity: paneInfo.activity, active: false, mergeCount: regEntry?.mergeCount ?? 0, failCount: regEntry?.failCount ?? 0 });
    }
  }

  // Include registry-only workers (e.g., merged workers whose windows are gone)
  const seenNames = new Set(workers.map(w => w.name));
  for (const entry of registryEntries) {
    if (!seenNames.has(entry.name) && entry.prState === "merged") {
      workers.push({
        name: entry.name,
        status: "merged",
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

interface PaneInfo {
  status: "ready" | "working" | "waiting" | "exited";
  activity: string | null;
}

function detectPaneProcessStatus(paneId: string): PaneInfo {
  const pid = getPanePid(paneId);
  if (!pid) return { status: "exited", activity: null };

  const claudePid = getClaudeChildPid(pid);
  if (!claudePid) return { status: "ready", activity: null };

  const activity = getPaneVar(paneId, "garden_task") ?? getPaneTitle(paneId) ?? null;
  if (!hasChildProcesses(claudePid)) {
    // Claude is idle — ready if no task yet, waiting if it has one
    return { status: activity ? "waiting" : "ready", activity };
  }
  return { status: "working", activity };
}
