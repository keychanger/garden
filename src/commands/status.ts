// Shows project status: registered projects, active workers, and their states.
import { loadConfig } from "../config.js";
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { output, isTTY } from "../output.js";
import { readDashState } from "../dashboard/state.js";
import { getWorkers } from "../dashboard/registry.js";
import { getProjectQueue } from "../dashboard/merge-queue.js";
import {
  getPanePid, getPaneTitle, getPaneLabel, getFirstPaneId,
  getClaudeChildPid, hasChildProcesses, listHiddenWorkerWindows,
} from "../dashboard/tmux.js";

interface WorkerInfo {
  name: string;
  status: "working" | "waiting" | "exited";
  activity: string | null;
  active: boolean;
}

interface QueueEntryInfo {
  prNumber: number;
  workerName: string;
  status: "merging" | "queued";
}

interface ProjectStatusInfo {
  name: string;
  index: number;
  isActive: boolean;
  workers: WorkerInfo[];
  queue: QueueEntryInfo[];
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
    const queueEntries = getProjectQueue(name);
    return {
      name,
      index: i + 1,
      isActive: dashState.activeProject === name,
      workers: hasDashboard ? getProjectWorkers(name, dashState) : [],
      queue: queueEntries.map((e, qi) => ({
        prNumber: e.prNumber,
        workerName: e.workerName,
        status: qi === 0 ? "merging" as const : "queued" as const,
      })),
    };
  });

  if (!isTTY) {
    output(statuses);
    return;
  }

  for (const project of statuses) {
    const marker = project.isActive ? " ◄" : "";
    console.log(`  ${project.index}. ${project.name}${marker}`);

    if (project.workers.length === 0 && project.queue.length === 0) {
      console.log("    (no workers)");
    } else {
      for (const worker of project.workers) {
        const icon = worker.active ? "●" : "○";
        const suffix = worker.activity ? ` — ${worker.activity}` : worker.status === "waiting" ? " (no task)" : "";
        console.log(`    ${icon} ${worker.name}  ${worker.status}${suffix}`);
      }
      for (const entry of project.queue) {
        console.log(`    ⏳ PR #${entry.prNumber} (${entry.workerName}) ${entry.status}`);
      }
    }
  }
}

function getProjectWorkers(projectName: string, dashState: { activeProject: string | null; activePaneId: string | null; activePaneType: string | null; activeWindowName?: string | null }): WorkerInfo[] {
  const workers: WorkerInfo[] = [];
  const activeWindowName = dashState.activeWindowName ?? null;
  const registryEntries = getWorkers(projectName);
  const registryTaskByName = new Map(registryEntries.map(e => [e.name, e.task]));

  if (dashState.activeProject === projectName && dashState.activePaneId && dashState.activePaneType === "worker") {
    const label = getPaneLabel(dashState.activePaneId) ?? "worker-1";
    const paneInfo = detectPaneProcessStatus(dashState.activePaneId);
    if (!paneInfo.activity) paneInfo.activity = registryTaskByName.get(label) || null;
    workers.push({ name: label, ...paneInfo, active: true });
  }

  const hiddenWindows = listHiddenWorkerWindows(projectName);
  for (const win of hiddenWindows) {
    if (win === activeWindowName) continue;
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${win}`);
    if (paneId) {
      const label = getPaneLabel(paneId) ?? win.replace(`_${projectName}-`, "");
      const paneInfo = detectPaneProcessStatus(paneId);
      if (!paneInfo.activity) paneInfo.activity = registryTaskByName.get(label) || null;
      workers.push({ name: label, ...paneInfo, active: false });
    }
  }

  workers.sort((a, b) => a.name.localeCompare(b.name));

  return workers;
}

interface PaneInfo {
  status: "working" | "waiting" | "exited";
  activity: string | null;
}

function detectPaneProcessStatus(paneId: string): PaneInfo {
  const pid = getPanePid(paneId);
  if (!pid) return { status: "exited", activity: null };

  const claudePid = getClaudeChildPid(pid);
  if (!claudePid) return { status: "waiting", activity: null };

  const activity = getPaneTitle(paneId);
  const status = hasChildProcesses(claudePid) ? "working" : "waiting";
  return { status, activity };
}
