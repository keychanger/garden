import path from "node:path";
import fs from "node:fs";
import { getProject } from "../config.js";
import {
  checkTmux,
  tmuxSessionExists,
  createTmuxSession,
  writeState,
} from "../session.js";
import { SESSIONS_DIR } from "../config.js";
import { addTask } from "../tasks.js";
import { emit } from "../events.js";

export async function start(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: garden start <name> [--auto] [prompt]");
  }

  checkTmux();
  const project = getProject(name);

  if (tmuxSessionExists(name)) {
    throw new Error(
      `Session '${name}' is already running. Use 'garden attach ${name}' or 'garden stop ${name}'.`
    );
  }

  const remaining = args.slice(1);
  let auto = false;
  const promptParts: string[] = [];

  for (const arg of remaining) {
    if (arg === "--auto") {
      auto = true;
    } else {
      promptParts.push(arg);
    }
  }

  const prompt = promptParts.length > 0 ? promptParts.join(" ") : null;

  // If an explicit prompt was given, create a task for it
  let taskId: string | null = null;
  if (prompt) {
    const task = addTask(project.path, prompt);
    taskId = task.id;
  }

  // Build the worker command
  const workerArgs = ["_worker", name, project.path];
  if (auto) workerArgs.push("--auto");
  if (taskId) workerArgs.push("--task", taskId);

  // Resolve the garden executable path
  const gardenBin = path.resolve(process.argv[1]);
  let runner: string;
  if (gardenBin.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(gardenBin));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    runner = fs.existsSync(tsxBin) ? `${tsxBin} ${gardenBin}` : `npx tsx ${gardenBin}`;
  } else {
    runner = `node ${gardenBin}`;
  }

  const command = `GARDEN_PROJECT=${shellEscape(name)} ${runner} ${workerArgs.map(shellEscape).join(" ")}`;

  if (process.env.GARDEN_DEBUG) {
    console.error(`[debug] tmux command: ${command}`);
  }

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  writeState(name, {
    mode: auto ? "auto" : "paused",
    currentTaskId: null,
    startedAt: new Date().toISOString(),
    completedTasks: 0,
    pid: null,
  });

  createTmuxSession(name, command, project.path);
  emit(name, "session_start", { mode: auto ? "auto" : "paused" });

  const modeLabel = auto ? "auto" : "paused";
  const taskLabel = prompt ? `task: ${prompt}` : "picking up from task list";
  console.log(`Started session '${name}' (${modeLabel}) — ${taskLabel}`);
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
