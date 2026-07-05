import { holdWorker } from "../dashboard/workers.js";
import { resolveWorkerArg } from "./resolve-worker.js";

// `garden hold <worker>` — interrupt a working worker and mark it `paused`.
// The dashboard `⌥e` hotkey is the primary path (it toggles hold/release on
// the focused worker); this CLI form is for scripting and out-of-dashboard
// use. The next prompt to the worker clears the hold.
export async function hold(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) throw new Error("Usage: garden hold <worker>");

  const { project, worker } = resolveWorkerArg(arg);
  const result = holdWorker(project, worker);
  console.log(result.message);
}
