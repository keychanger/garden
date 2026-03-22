// Outputs project context (tasks, session state) for agent bootstrapping.
import { resolveProject } from "../config.js";
import { readTasks, type Task } from "../tasks.js";
import { readState } from "../session.js";
import { output } from "../output.js";

export async function context(args: string[]): Promise<void> {
  const project = resolveProject(args[0]);
  const tasks = readTasks(project.path);
  const state = readState(project.name);

  const data = {
    project: project.name,
    path: project.path,
    tasks,
    session: state,
  };

  output(data, () => formatContext(project.name, tasks, state));
}

function formatContext(
  name: string,
  tasks: Task[],
  state: { currentTaskId: string | null } | null
): string {
  const lines: string[] = [];

  lines.push(`You are working in a garden-managed project called "${name}".`);
  lines.push("");
  lines.push("## Available commands");
  lines.push("");
  lines.push("Run these in the shell to manage your tasks:");
  lines.push("  garden tasks add \"<description>\"  — add a new task you discover");
  lines.push("  garden tasks done <id>            — mark a task complete");
  lines.push("  garden tasks block <id> [reason]  — mark a task blocked (you're stuck)");
  lines.push("  garden tasks                      — list all tasks");
  lines.push("");

  if (state?.currentTaskId) {
    const current = tasks.find((t) => t.id === state.currentTaskId);
    if (current) {
      lines.push(`## Current task`);
      lines.push("");
      lines.push(`ID: ${current.id}`);
      lines.push(`Description: ${current.description}`);
      if (current.notes.length > 0) {
        lines.push(`Notes:`);
        for (const note of current.notes) {
          lines.push(`  - ${note}`);
        }
      }
      lines.push("");
      lines.push(`When you finish this task, run: garden tasks done ${current.id}`);
      lines.push(`If you get stuck, run: garden tasks block ${current.id} "reason"`);
      lines.push("");
    }
  }

  const pending = tasks.filter((t) => t.status === "pending");
  if (pending.length > 0) {
    lines.push(`## Pending tasks (${pending.length})`);
    lines.push("");
    for (const t of pending) {
      lines.push(`  ${t.id}: ${t.description}`);
    }
    lines.push("");
  }

  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    lines.push(`## Blocked tasks (${blocked.length})`);
    lines.push("");
    for (const t of blocked) {
      const reason = t.notes.length > 0 ? ` — ${t.notes[t.notes.length - 1]}` : "";
      lines.push(`  ${t.id}: ${t.description}${reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
