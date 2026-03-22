import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readState, writeState, getLogPath } from "./session.js";
import { SESSIONS_DIR } from "./config.js";
import { nextTask, getTask, markInProgress, markDone, type Task } from "./tasks.js";
import { emit } from "./events.js";
import { notify } from "./notify.js";

// argv: [node, cli.ts, _worker, name, projectPath, ...flags]
const name = process.argv[3];
const projectPath = process.argv[4];
const remaining = process.argv.slice(5);

let mode: "paused" | "auto" = "paused";
let startTaskId: string | null = null;

for (let i = 0; i < remaining.length; i++) {
  if (remaining[i] === "--auto") {
    mode = "auto";
  } else if (remaining[i] === "--task" && remaining[i + 1]) {
    startTaskId = remaining[++i];
  }
}

if (!name || !projectPath) {
  console.error("Usage: garden _worker <name> <projectPath> [--auto] [--task <id>]");
  process.exit(1);
}

const logFile = getLogPath(name);

function updateState(updates: Record<string, unknown>): void {
  const current = readState(name) ?? {
    mode,
    currentTaskId: null,
    startedAt: new Date().toISOString(),
    completedTasks: 0,
    pid: process.pid,
  };
  writeState(name, { ...current, ...updates });
}

function buildContext(task: Task): string {
  // Build the garden context that gets injected into Claude's system prompt
  const lines: string[] = [];
  lines.push(`You are working in a garden-managed project called "${name}".`);
  lines.push("");
  lines.push("When you complete your task, run this command in the shell:");
  lines.push(`  garden tasks done ${task.id}`);
  lines.push("");
  lines.push("If you get stuck and cannot complete the task, run:");
  lines.push(`  garden tasks block ${task.id} "reason you are stuck"`);
  lines.push("");
  lines.push("If you discover additional work, add new tasks:");
  lines.push(`  garden tasks add "description of new task"`);
  lines.push("");
  lines.push("Do not edit .garden/tasks.json directly — always use the garden CLI.");
  return lines.join("\n");
}

function runClaude(task: Task): boolean {
  console.log(`\n--- Task ${task.id}: ${task.description} ---\n`);
  const context = buildContext(task);

  // Write context to a temp file to avoid shell escaping issues
  const contextFile = path.join(SESSIONS_DIR, `${name}.context`);
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });
  fs.writeFileSync(contextFile, context);

  try {
    const args = [
      "-p",
      "--verbose",
      task.description,
      "--append-system-prompt-file", contextFile,
      "--allowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep",
    ];

    const output = execFileSync("claude", args, {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, GARDEN_PROJECT: name },
    });

    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, output);
    console.log(output);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Claude error: ${message}`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `Error: ${message}`);
    return false;
  }
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const keepalive = setInterval(() => {}, 60_000);
    const handler = () => {
      clearInterval(keepalive);
      process.removeListener("SIGUSR1", handler);
      resolve();
    };
    process.on("SIGUSR1", handler);
  });
}

async function run(): Promise<void> {
  updateState({ pid: process.pid, mode });
  let completed = 0;

  while (true) {
    // Get next task — either the explicitly requested one, or next pending
    let task: Task | null = null;
    if (startTaskId) {
      task = getTask(projectPath, startTaskId);
      startTaskId = null; // only use this once
    } else {
      task = nextTask(projectPath);
    }

    if (!task) {
      emit(name, "session_idle", { reason: "no_pending_tasks" });
      notify("Garden", `${name}: no remaining tasks`);
      console.log("\nNo remaining tasks. Session idle.");
      updateState({ currentTaskId: null, completedTasks: completed });
      await waitForSignal();
      continue;
    }

    // Set task to in_progress
    markInProgress(projectPath, task.id);
    updateState({ currentTaskId: task.id });
    emit(name, "task_start", { taskId: task.id, description: task.description });

    const ok = runClaude(task);

    // Check task status — Claude may have marked it done/blocked via CLI
    const updatedTask = getTask(projectPath, task.id);
    const finalStatus = updatedTask?.status ?? (ok ? "done" : "failed");

    if (finalStatus === "done") {
      completed++;
      emit(name, "task_done", { taskId: task.id, description: task.description });
      notify("Garden", `${name} finished: ${task.description}`);
    } else if (finalStatus === "blocked") {
      const reason = updatedTask?.notes[updatedTask.notes.length - 1] ?? "";
      emit(name, "task_blocked", { taskId: task.id, description: task.description, reason });
      notify("Garden", `${name} blocked: ${task.description} — ${reason}`);
    } else if (finalStatus === "in_progress" && ok) {
      // Claude exited successfully but didn't explicitly mark done — auto-complete
      markDone(projectPath, task.id);
      completed++;
      emit(name, "task_done", { taskId: task.id, description: task.description });
      notify("Garden", `${name} finished: ${task.description}`);
    } else {
      // Claude errored out or task still in_progress after failure
      emit(name, "task_failed", { taskId: task.id, description: task.description });
      notify("Garden", `${name} failed: ${task.description}`);
    }

    updateState({ currentTaskId: null, completedTasks: completed });

    // Re-read mode from state file (garden pause may have changed it)
    const currentState = readState(name);
    mode = currentState?.mode ?? mode;

    if (mode === "paused") {
      console.log("\nTask complete. Waiting for 'garden next'...");
      await waitForSignal();
    }
  }
}

export const workerPromise = run().catch((err) => {
  console.error("Worker error:", err);
  process.exit(1);
});
