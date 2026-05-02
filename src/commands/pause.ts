import fs from "node:fs";
import { readRegistry } from "../dashboard/registry.js";
import { donePath } from "../dashboard/continue.js";

export async function pause(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden pause <worker>");

  const registry = readRegistry();
  const matches: Array<{ project: string; worktreePath?: string }> = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.name === workerName) {
        matches.push({ project, worktreePath: entry.worktreePath });
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`No worker found with name '${workerName}'`);
  }
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.project}/${workerName}`).join("\n");
    throw new Error(`Multiple workers match '${workerName}':\n${list}\nKill or rename one first.`);
  }

  const { project, worktreePath } = matches[0];
  if (!worktreePath) {
    throw new Error(
      `Worker ${project}/${workerName} has no worktreePath in the registry — `
      + `cannot pause. (Legacy workers from before the worktree workflow do not `
      + `support pause/resume; kill and recreate.)`,
    );
  }
  const target = donePath(worktreePath);
  fs.writeFileSync(target, "");
  console.log(`Paused ${project}/${workerName} — auto-continue suppressed (sentinel: ${target}).`);
}
