// Internal task loop that runs inside tmux, dispatching tasks to Claude Code sessions.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readState, writeState } from "./session.js";
import { SESSIONS_DIR, GARDEN_DIR } from "./config.js";
import { nextTask, getTask, markInProgress, type Task } from "./tasks.js";
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

function updateState(updates: Record<string, unknown>): void {
  const current = readState(name) ?? {
    mode,
    currentTaskId: null,
    lastTaskId: null,
    startedAt: new Date().toISOString(),
    completedTasks: 0,
    pid: process.pid,
  };
  writeState(name, { ...current, ...updates });
}

function loadRulesFile(filePath: string): string {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8").trim();
  }
  return "";
}

function buildContext(task: Task): string {
  const sections: string[] = [];

  // Core garden instructions
  sections.push(`You are working in a garden-managed project called "${name}".

## Task management

When you complete your task, run:
  garden tasks done ${task.id}

If you cannot complete the task, run:
  garden tasks block ${task.id} "specific reason you are blocked"

If you discover additional work, run:
  garden tasks add "description of new task"

Do not edit .garden/tasks.json directly — always use the garden CLI.

## Agent behavior

Do not ask clarifying questions. You are running non-interactively.
- Make your best judgment and proceed.
- If you truly cannot proceed without more information, block the task with a specific description of what you need.
- Never produce partial work and stop. Either complete the task fully or block it.
- If a task is ambiguous, make a reasonable choice and document what you chose in the task notes: garden tasks update ${task.id} --note "chose X because Y"`);

  // Global rules (~/.garden/rules.md)
  const globalRules = loadRulesFile(path.join(GARDEN_DIR, "rules.md"));
  if (globalRules) {
    sections.push(`## Global rules\n\n${globalRules}`);
  }

  // Project rules (<project>/.garden/rules.md)
  const projectRules = loadRulesFile(path.join(projectPath, ".garden", "rules.md"));
  if (projectRules) {
    sections.push(`## Project rules\n\n${projectRules}`);
  }

  // Task context
  if (task.notes.length > 0) {
    sections.push(`## Task notes\n\n${task.notes.map(n => `- ${n}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

function runClaude(task: Task): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n--- Task ${task.id}: ${task.description} ---\n`);

    const contextFile = path.join(SESSIONS_DIR, `${name}.context`);
    fs.mkdirSync(path.dirname(contextFile), { recursive: true });
    fs.writeFileSync(contextFile, buildContext(task));

    const sessionName = `garden-${name}-${task.id}`;
    const args = [
      "-p",
      "--verbose",
      task.description,
      "--name", sessionName,
      "--append-system-prompt-file", contextFile,
      "--allowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep",
    ];

    // Spawn claude in print mode — output streams to the tmux terminal
    const child = spawn("claude", args, {
      cwd: projectPath,
      stdio: "inherit",
      env: { ...process.env, GARDEN_PROJECT: name },
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });

    child.on("error", (err) => {
      console.error(`Failed to start claude: ${err.message}`);
      resolve(false);
    });
  });
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
    let task: Task | null = null;
    if (startTaskId) {
      task = getTask(projectPath, startTaskId);
      startTaskId = null;
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

    markInProgress(projectPath, task.id);
    updateState({ currentTaskId: task.id });
    emit(name, "task_start", { taskId: task.id, description: task.description });

    const ok = await runClaude(task);

    // Check task status — Claude should have called garden tasks done/block
    const updatedTask = getTask(projectPath, task.id);
    const finalStatus = updatedTask?.status ?? "in_progress";

    if (finalStatus === "done") {
      completed++;
      emit(name, "task_done", { taskId: task.id, description: task.description });
      notify("Garden", `${name} finished: ${task.description}`);
    } else if (finalStatus === "blocked") {
      const reason = updatedTask?.notes[updatedTask.notes.length - 1] ?? "";
      emit(name, "task_blocked", { taskId: task.id, description: task.description, reason });
      notify("Garden", `${name} blocked: ${task.description} — ${reason}`);
    } else {
      const eventType = ok ? "task_incomplete" : "task_failed";
      emit(name, eventType, { taskId: task.id, description: task.description });
      notify("Garden", `${name} ${ok ? "incomplete" : "failed"}: ${task.description}`);
    }

    updateState({ currentTaskId: null, lastTaskId: task.id, completedTasks: completed });

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
