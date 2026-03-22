// Shows session status for one or all projects.
import { loadConfig, getProject } from "../config.js";
import { tmuxSessionExists, readState } from "../session.js";
import { output, outputLines } from "../output.js";

interface StatusInfo {
  name: string;
  running: boolean;
  mode: string | null;
  currentTaskId: string | null;
  completedTasks: number;
  startedAt: string | null;
}

export async function status(args: string[]): Promise<void> {
  const name = args[0];

  if (name) {
    getProject(name); // validates
    const info = projectStatus(name);
    output(info, (data) => {
      const s = data as StatusInfo;
      if (!s.running) return `${s.name}: stopped`;
      const lines = [
        `${s.name}: running`,
        `  Mode:      ${s.mode}`,
        `  Task:      ${s.currentTaskId ?? "(idle)"}`,
        `  Completed: ${s.completedTasks}`,
        `  Started:   ${s.startedAt}`,
      ];
      return lines.join("\n");
    });
    return;
  }

  const config = loadConfig();
  const names = Object.keys(config.projects);
  if (names.length === 0) {
    console.log("No projects registered.");
    return;
  }

  const statuses = names.sort().map(projectStatus);
  outputLines(statuses, (data) => {
    const s = data as StatusInfo;
    const icon = s.running ? "●" : "○";
    let detail = "stopped";
    if (s.running) {
      if (s.currentTaskId) {
        detail = `running  task: ${s.currentTaskId}`;
      } else if (s.mode === "paused") {
        detail = `paused   (${s.completedTasks} done)`;
      } else {
        detail = `running  (${s.completedTasks} done)`;
      }
    }
    return `  ${s.name.padEnd(16)} ${icon} ${detail}`;
  });
}

function projectStatus(name: string): StatusInfo {
  const running = tmuxSessionExists(name);
  const state = readState(name);
  return {
    name,
    running,
    mode: running ? (state?.mode ?? null) : null,
    currentTaskId: state?.currentTaskId ?? null,
    completedTasks: state?.completedTasks ?? 0,
    startedAt: state?.startedAt ?? null,
  };
}
