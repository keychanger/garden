import { bounceWorker } from "../dashboard/workers.js";
import { resolveWorkerArg } from "./resolve-worker.js";

export async function bounce(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) throw new Error("Usage: garden bounce <worker>");

  const { project, worker } = resolveWorkerArg(arg);
  bounceWorker(project, worker);
  console.log(`Bounced ${project}/${worker} — Claude resumed with fresh settings.`);
}
