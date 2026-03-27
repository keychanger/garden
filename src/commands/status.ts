// Shows project status: registered projects, active workers, and their states.
import { loadConfig } from "../config.js";
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { output, isTTY } from "../output.js";
import { readDashState } from "../dashboard/state.js";
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

interface ProjectStatusInfo {
  name: string;
  index: number;
  isActive: boolean;
  workers: WorkerInfo[];
}

export async function status(_args: string[]): Promise<void> {
  const config = loadConfig();
  const names = Object.keys(config.projects);

  if (names.length === 0) {
    console.log("No projects registered.");
    return;
  }

  const dashState = readDashState();
  const hasDashboard = dashboardExists();

  const statuses: ProjectStatusInfo[] = names.map((name, i) => ({
    name,
    index: i + 1,
    isActive: dashState.activeProject === name,
    workers: hasDashboard ? getProjectWorkers(name, dashState) : [],
  }));

  if (!isTTY) {
    output(statuses);
    return;
  }

  for (const project of statuses) {
    const marker = project.isActive ? " ◄" : "";
    console.log(`  ${project.index}. ${project.name}${marker}`);

    if (project.workers.length === 0) {
      console.log("    (no workers)");
    } else {
      for (const worker of project.workers) {
        const icon = worker.active ? "●" : "○";
        const activity = worker.activity ? ` — ${worker.activity}` : "";
        console.log(`    ${icon} ${worker.name}  ${worker.status}${activity}`);
      }
    }
  }
}

function getProjectWorkers(projectName: string, dashState: { activeProject: string | null; activePaneId: string | null; activePaneType: string | null }): WorkerInfo[] {
  const workers: WorkerInfo[] = [];

  if (dashState.activeProject === projectName && dashState.activePaneId && dashState.activePaneType === "worker") {
    const label = getPaneLabel(dashState.activePaneId) ?? "worker-1";
    const paneInfo = detectPaneProcessStatus(dashState.activePaneId);
    workers.push({ name: label, ...paneInfo, active: true });
  }

  const hiddenWindows = listHiddenWorkerWindows(projectName);
  for (const win of hiddenWindows) {
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${win}`);
    if (paneId) {
      const label = getPaneLabel(paneId) ?? win.replace(`_${projectName}-`, "");
      const paneInfo = detectPaneProcessStatus(paneId);
      workers.push({ name: label, ...paneInfo, active: false });
    }
  }

  workers.sort((a, b) => {
    const numA = parseInt(a.name.replace(/\D/g, ""), 10) || 0;
    const numB = parseInt(b.name.replace(/\D/g, ""), 10) || 0;
    return numA - numB;
  });

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
