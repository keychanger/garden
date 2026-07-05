import fs from "node:fs";
import { donePath } from "../dashboard/continue.js";
import { resolveWorkerArg } from "./resolve-worker.js";

export async function pause(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) throw new Error("Usage: garden pause <worker>");

  const { project, worker: workerName, entry } = resolveWorkerArg(arg);
  const worktreePath = entry.worktreePath;
  if (!worktreePath) {
    throw new Error(
      `Worker ${project}/${workerName} has no worktreePath in the registry — `
      + `cannot pause. (Legacy workers from before the worktree workflow do not `
      + `support pause/resume; kill and recreate.)`,
    );
  }
  const target = donePath(worktreePath);
  fs.writeFileSync(target, "");
  console.log(
    `Paused ${project}/${workerName} — auto-continue suppressed (sentinel: ${target}).\n`
    + `Note: a worker UserPromptSubmit will clear the sentinel, so prompting this worker `
    + `is itself an unpause signal.`,
  );
}
