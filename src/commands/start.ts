// Starts a new tmux session running the garden worker for a project.
import path from "node:path";
import fs from "node:fs";
import { resolveProjectFromArgs, loadConfig } from "../config.js";
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
  checkTmux();

  if (args[0] === "--all" || args[0] === "-a") {
    const auto = args.includes("--auto");
    await startAll(auto);
    return;
  }

  const { project, remainingArgs } = resolveProjectFromArgs(args);
  const name = project.name;

  if (tmuxSessionExists(name)) {
    throw new Error(
      `Session '${name}' is already running. Use 'garden attach ${name}' or 'garden stop ${name}'.`
    );
  }

  let auto = false;
  const promptParts: string[] = [];

  for (const arg of remainingArgs) {
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
    lastTaskId: null,
    startedAt: new Date().toISOString(),
    completedTasks: 0,
    pid: null,
  });

  createTmuxSession(name, command, project.path);
  emit(name, "session_start", { mode: auto ? "auto" : "paused" });

  const modeLabel = auto ? " (auto)" : "";
  const detail = prompt ? ` — "${prompt}"` : "";
  console.log(`Started ${name}${modeLabel}${detail}`);
}

async function startAll(auto: boolean): Promise<void> {
  const config = loadConfig();
  const projectNames = Object.keys(config.projects);
  if (projectNames.length === 0) {
    console.log("No projects registered.");
    return;
  }

  let started = 0;
  let skipped = 0;
  for (const name of projectNames) {
    if (tmuxSessionExists(name)) {
      console.log(`Skipping '${name}' — already running.`);
      skipped++;
      continue;
    }

    const project = config.projects[name];
    const workerArgs = ["_worker", name, project.path];
    if (auto) workerArgs.push("--auto");

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
      lastTaskId: null,
      startedAt: new Date().toISOString(),
      completedTasks: 0,
      pid: null,
    });

    createTmuxSession(name, command, project.path);
    emit(name, "session_start", { mode: auto ? "auto" : "paused" });

    const modeLabel = auto ? " (auto)" : "";
    console.log(`Started ${name}${modeLabel}`);
    started++;
  }

  console.log(`\nStarted ${started} session(s)${skipped > 0 ? `, skipped ${skipped} already running` : ""}.`);
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
