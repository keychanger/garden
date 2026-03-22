// Resumes a Claude Code conversation from a task for review.
import { execSync } from "node:child_process";
import { readState } from "../session.js";
import { resolveProjectFromArgs, tryGetProject } from "../config.js";

export async function review(args: string[]): Promise<void> {
  // Check if any arg looks like a task ID (short hex string)
  let taskId: string | null = null;
  const filteredArgs: string[] = [];

  for (const arg of args) {
    if (/^[a-f0-9]{4,}$/.test(arg) && !tryGetProject(arg)) {
      taskId = arg;
    } else {
      filteredArgs.push(arg);
    }
  }

  const { project } = resolveProjectFromArgs(filteredArgs);
  const name = project.name;

  if (!taskId) {
    const state = readState(name);
    taskId = state?.lastTaskId ?? state?.currentTaskId ?? null;
  }

  if (!taskId) {
    console.log(`No task history for '${name}'.`);
    return;
  }

  const sessionName = `garden-${name}-${taskId}`;
  console.log(`Resuming conversation for task ${taskId}...`);
  console.log();

  execSync(`claude --resume "${sessionName}"`, {
    cwd: project.path,
    stdio: "inherit",
  });
}
