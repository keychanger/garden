import { readRegistry } from "../dashboard/registry.js";
import { holdWorker } from "../dashboard/workers.js";

// `garden hold <worker>` — interrupt a working worker and mark it `paused`.
// The dashboard `⌥e` hotkey is the primary path (it toggles hold/release on
// the focused worker); this CLI form is for scripting and out-of-dashboard
// use. The next prompt to the worker clears the hold.
export async function hold(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden hold <worker>");

  const registry = readRegistry();
  const matches: Array<{ project: string }> = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.name === workerName) matches.push({ project });
    }
  }

  if (matches.length === 0) {
    throw new Error(`No worker found with name '${workerName}'`);
  }
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.project}/${workerName}`).join("\n");
    throw new Error(`Multiple workers match '${workerName}':\n${list}\nRename one first.`);
  }

  const result = holdWorker(matches[0].project, workerName);
  console.log(result.message);
}
