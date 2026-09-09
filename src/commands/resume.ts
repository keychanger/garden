import fs from "node:fs";
import { awaitingInputPath, donePath } from "../dashboard/continue.js";
import { updateWorkerFields } from "../dashboard/registry.js";
import { refreshDashboard } from "../dashboard/header.js";
import { resolveWorkerArg } from "./resolve-worker.js";

// `garden resume <worker>` — re-arm post-merge auto-continue by clearing
// whichever sentinel is suppressing it. Two can be: `.garden-done` (the worker
// declared itself finished, or `garden pause` wrote it) and
// `.garden-awaiting-input` (the worker stopped to ask via `garden blocked`, or a
// designer parked at its human gate). Both suppress the same prompt, so both are
// this command's business — clearing only the first would leave a blocked worker
// reporting "resumed" while nothing resumed.
export async function resume(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) throw new Error("Usage: garden resume <worker>");

  const { project, worker: workerName, entry } = resolveWorkerArg(arg);
  const worktreePath = entry.worktreePath;
  if (!worktreePath) {
    throw new Error(
      `Worker ${project}/${workerName} has no worktreePath in the registry — `
      + `cannot resume. (Legacy workers from before the worktree workflow do not `
      + `support pause/resume; kill and recreate.)`,
    );
  }
  const cleared: string[] = [];
  for (const target of [donePath(worktreePath), awaitingInputPath(worktreePath)]) {
    if (!fs.existsSync(target)) continue;
    try { fs.unlinkSync(target); } catch { /* raced with the worker's own clear */ }
    cleared.push(target);
  }
  // The registry half of a block. Dropped whenever the worker was blocked, even
  // if its sentinel had already gone: the field is what flags the row and lifts
  // it to the blocked-on-you tier, so leaving it would keep asking the operator
  // for an answer they just said they were done giving.
  if (entry.blockedQuestion !== undefined) {
    updateWorkerFields(project, workerName, { blockedQuestion: undefined });
    // Non-fatal for the same reason as blockWorker's: the unblock has already
    // landed in the registry, so a repaint that cannot reach tmux must not turn
    // a successful resume into a reported failure.
    try { refreshDashboard(); } catch { /* dashboard not reachable from here */ }
    cleared.push("blocked question");
  }
  if (cleared.length > 0) {
    console.log(`Resumed ${project}/${workerName} — auto-continue will fire on next merge.`);
  } else {
    console.log(`${project}/${workerName} was not paused or blocked.`);
  }
}
