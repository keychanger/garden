import { loadConfig } from "../config.js";
import { tmuxSessionExists, readState } from "../session.js";
import { output } from "../output.js";

interface ProjectInfo {
  name: string;
  path: string;
  running: boolean;
  mode: string | null;
  currentTask: string | null;
  completedTasks: number;
}

export async function list(): Promise<void> {
  const config = loadConfig();
  const names = Object.keys(config.projects);

  if (names.length === 0) {
    console.log("No projects registered. Use 'garden add <name> <path>' to add one.");
    return;
  }

  const projects: ProjectInfo[] = names.sort().map((name) => {
    const running = tmuxSessionExists(name);
    const state = readState(name);
    return {
      name,
      path: config.projects[name].path,
      running,
      mode: running ? (state?.mode ?? null) : null,
      currentTask: state?.currentTaskId ?? null,
      completedTasks: state?.completedTasks ?? 0,
    };
  });

  output(projects, (data) => {
    const items = data as ProjectInfo[];
    return items
      .map((p) => {
        const icon = p.running ? "●" : "○";
        let detail = "stopped";
        if (p.running) {
          if (p.currentTask) {
            detail = `running  task: ${p.currentTask}`;
          } else if (p.mode === "paused") {
            detail = `paused   (${p.completedTasks} done)`;
          } else {
            detail = `running  (${p.completedTasks} done)`;
          }
        }
        return `  ${p.name.padEnd(16)} ${icon} ${detail}`;
      })
      .join("\n");
  });
}
