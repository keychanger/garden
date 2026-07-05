import fs from "node:fs";
import { donePath } from "../dashboard/continue.js";
import { resolveWorkerArg } from "./resolve-worker.js";

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
  const target = donePath(worktreePath);
  const existed = fs.existsSync(target);
  try { fs.unlinkSync(target); } catch { /* not present */ }
  if (existed) {
    console.log(`Resumed ${project}/${workerName} — auto-continue will fire on next merge.`);
  } else {
    console.log(`${project}/${workerName} was not paused (no sentinel at ${target}).`);
  }
}
