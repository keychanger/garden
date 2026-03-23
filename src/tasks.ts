// CRUD operations for per-project task lists stored in .garden/tasks.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TASKS_DIR = ".garden";
const TASKS_FILE = "tasks.json";

export type TaskStatus = "backlog" | "pending" | "in_progress" | "done" | "blocked" | "failed";

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  notes: string[];
  created: string;
  completed?: string;
}

interface TasksFile {
  tasks: Task[];
}

function tasksPath(projectPath: string): string {
  return path.join(projectPath, TASKS_DIR, TASKS_FILE);
}

function generateId(): string {
  return crypto.randomBytes(2).toString("hex");
}

export function readTasks(projectPath: string): Task[] {
  const filePath = tasksPath(projectPath);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as TasksFile;
    return data.tasks ?? [];
  } catch {
    return [];
  }
}

function writeTasks(projectPath: string, tasks: Task[]): void {
  const filePath = tasksPath(projectPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data: TasksFile = { tasks };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function nextTask(projectPath: string): Task | null {
  const tasks = readTasks(projectPath);
  // Pick up interrupted tasks first, then pending
  return tasks.find((t) => t.status === "in_progress")
    ?? tasks.find((t) => t.status === "pending")
    ?? null;
}

export function resetInProgress(projectPath: string): number {
  const tasks = readTasks(projectPath);
  let count = 0;
  for (const task of tasks) {
    if (task.status === "in_progress") {
      task.status = "pending";
      count++;
    }
  }
  if (count > 0) writeTasks(projectPath, tasks);
  return count;
}

export function addTask(projectPath: string, description: string, status: TaskStatus = "pending"): Task {
  const tasks = readTasks(projectPath);
  const task: Task = {
    id: generateId(),
    description,
    status,
    notes: [],
    created: new Date().toISOString(),
  };
  tasks.push(task);
  writeTasks(projectPath, tasks);
  return task;
}

export function getTask(projectPath: string, id: string): Task | null {
  const tasks = readTasks(projectPath);
  return tasks.find((t) => t.id === id) ?? null;
}

export function updateTask(
  projectPath: string,
  id: string,
  updates: Partial<Pick<Task, "status" | "description"> & { note: string }>
): Task {
  const tasks = readTasks(projectPath);
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);

  if (updates.status) {
    task.status = updates.status;
    if (updates.status === "done" || updates.status === "failed") {
      task.completed = new Date().toISOString();
    }
  }
  if (updates.description) task.description = updates.description;
  if (updates.note) task.notes.push(updates.note);

  writeTasks(projectPath, tasks);
  return task;
}

export function markDone(projectPath: string, id: string): Task {
  return updateTask(projectPath, id, { status: "done" });
}

export function markBlocked(projectPath: string, id: string, reason?: string): Task {
  return updateTask(projectPath, id, {
    status: "blocked",
    ...(reason ? { note: reason } : {}),
  });
}

export function markInProgress(projectPath: string, id: string): Task {
  return updateTask(projectPath, id, { status: "in_progress" });
}

export function removeTask(projectPath: string, id: string): Task {
  const tasks = readTasks(projectPath);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Task not found: ${id}`);
  const [removed] = tasks.splice(idx, 1);
  writeTasks(projectPath, tasks);
  return removed;
}
