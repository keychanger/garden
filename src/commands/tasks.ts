// CLI interface for task management: list, add, done, block, update, and next.
import { resolveProject } from "../config.js";
import { readTasks, addTask, markDone, markBlocked, updateTask, nextTask, removeTask, type Task } from "../tasks.js";
import { emit } from "../events.js";
import { output, outputLines } from "../output.js";

export async function tasks(args: string[]): Promise<void> {
  // Detect subcommand: add, done, block, update, next — or list (default)
  // Format: garden tasks [name] [subcommand] [args...]
  // If GARDEN_PROJECT is set, name is optional

  const parsed = parseTaskArgs(args);
  const project = resolveProject(parsed.projectName);

  switch (parsed.subcommand) {
    case "add": {
      const desc = parsed.rest.join(" ");
      if (!desc) throw new Error("Usage: garden tasks [name] add <description>");
      const task = addTask(project.path, desc);
      emit(project.name, "task_add", { taskId: task.id, description: desc });
      output(task, (t) => `Added task ${(t as Task).id}: ${(t as Task).description}`);
      return;
    }

    case "backlog": {
      const desc = parsed.rest.join(" ");
      if (!desc) throw new Error("Usage: garden tasks [name] backlog <description>");
      const task = addTask(project.path, desc, "backlog");
      emit(project.name, "task_add", { taskId: task.id, description: desc, status: "backlog" });
      output(task, (t) => `Backlog ${(t as Task).id}: ${(t as Task).description}`);
      return;
    }

    case "done": {
      const id = parsed.rest[0];
      if (!id) throw new Error("Usage: garden tasks [name] done <id>");
      const task = markDone(project.path, id);
      emit(project.name, "task_done", { taskId: id, description: task.description });
      output(task, (t) => `Marked ${(t as Task).id} done: ${(t as Task).description}`);
      return;
    }

    case "block": {
      const id = parsed.rest[0];
      if (!id) throw new Error("Usage: garden tasks [name] block <id> [reason]");
      const reason = parsed.rest.slice(1).join(" ") || undefined;
      const task = markBlocked(project.path, id, reason);
      emit(project.name, "task_blocked", { taskId: id, description: task.description, reason });
      output(task, (t) => {
        const tk = t as Task;
        return `Blocked ${tk.id}: ${tk.description}${reason ? ` — ${reason}` : ""}`;
      });
      return;
    }

    case "remove": {
      const id = parsed.rest[0];
      if (!id) throw new Error("Usage: garden tasks [name] remove <id>");
      const task = removeTask(project.path, id);
      emit(project.name, "task_remove", { taskId: id, description: task.description });
      output(task, (t) => `Removed task ${(t as Task).id}: ${(t as Task).description}`);
      return;
    }

    case "update": {
      const id = parsed.rest[0];
      if (!id) throw new Error("Usage: garden tasks [name] update <id> [--status X] [--note X] [--desc X]");
      const updates = parseUpdateFlags(parsed.rest.slice(1));
      const task = updateTask(project.path, id, updates);
      output(task, (t) => `Updated ${(t as Task).id}: ${(t as Task).description}`);
      return;
    }

    case "next": {
      const task = nextTask(project.path);
      if (!task) {
        output(null, () => "No pending tasks.");
        return;
      }
      output(task, (t) => {
        const tk = t as Task;
        return `${tk.id}: ${tk.description}`;
      });
      return;
    }

    default: {
      // List all tasks
      const taskList = readTasks(project.path);
      if (taskList.length === 0) {
        console.log(`No tasks. Add one with: garden tasks${parsed.projectName ? ` ${parsed.projectName}` : ""} add <description>`);
        return;
      }
      outputLines(taskList, (item) => {
        const t = item as Task;
        const statusIcon = {
          backlog: "-",
          pending: "○",
          in_progress: "◐",
          done: "●",
          blocked: "✕",
          failed: "✕",
        }[t.status];
        const notes = t.notes.length > 0 ? ` (${t.notes[t.notes.length - 1]})` : "";
        return `  ${t.id}  ${statusIcon} ${t.status.padEnd(12)} ${t.description}${notes}`;
      });
    }
  }
}

const SUBCOMMANDS = new Set(["add", "backlog", "done", "block", "remove", "update", "next"]);

function parseTaskArgs(args: string[]): {
  projectName: string | undefined;
  subcommand: string | undefined;
  rest: string[];
} {
  // If first arg is a subcommand, no project name given
  if (SUBCOMMANDS.has(args[0])) {
    return { projectName: undefined, subcommand: args[0], rest: args.slice(1) };
  }

  // First arg might be a project name
  const projectName = args[0];
  if (SUBCOMMANDS.has(args[1])) {
    return { projectName, subcommand: args[1], rest: args.slice(2) };
  }

  // No subcommand — it's a list
  return { projectName, subcommand: undefined, rest: [] };
}

function parseUpdateFlags(args: string[]): Record<string, string> {
  const updates: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status" && args[i + 1]) {
      updates.status = args[++i];
    } else if (args[i] === "--note" && args[i + 1]) {
      updates.note = args[++i];
    } else if (args[i] === "--desc" && args[i + 1]) {
      updates.description = args[++i];
    }
  }
  return updates;
}
