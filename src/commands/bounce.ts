import { readRegistry } from "../dashboard/registry.js";
import { bounceWorker } from "../dashboard/workers.js";

export async function bounce(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden bounce <worker>");

  const registry = readRegistry();
  const matches: Array<{ project: string; worker: string }> = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.name === workerName) matches.push({ project, worker: entry.name });
    }
  }

  if (matches.length === 0) {
    throw new Error(`No worker found with name '${workerName}'`);
  }
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.project}/${m.worker}`).join("\n");
    throw new Error(`Multiple workers match '${workerName}':\n${list}\nRename one first.`);
  }

  const { project } = matches[0];
  bounceWorker(project, workerName);
  console.log(`Bounced ${project}/${workerName} — Claude resumed with fresh settings.`);
}
