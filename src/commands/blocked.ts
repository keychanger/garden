// `garden blocked "<question>"` — a worker's third exit from a turn.
//
// Beside "keep going" (end the turn and let the post-merge auto-continue
// advance you) and "done" (.garden-done), this is the exit for a worker that
// has pushed what it can and genuinely cannot proceed without an operator
// decision. It parks the worker on the blocked-on-you tier with the question on
// its row and plot as asking, and suppresses auto-continue — see blockWorker
// (dashboard/workers.ts) for why the other two exits could not express this.
//
// Self-resolves the worker via $GARDEN_WORKER so a worker can invoke it from
// its own pane with no arguments but the question, mirroring
// `garden designer publish` / `garden workers grow`.
import { blockWorker } from "../dashboard/workers.js";
import { findWorkerByName } from "../dashboard/registry.js";
import { resolveWorkerArg } from "./resolve-worker.js";

const USAGE = 'Usage: garden blocked "<what you need decided>" [--worker <worker>]';

export async function blocked(args: string[]): Promise<void> {
  const positional: string[] = [];
  let workerArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--worker" || a === "-w") {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) throw new Error(`${a} requires a value`);
      workerArg = val;
      i++;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag '${a}'. ${USAGE}`);
    } else {
      positional.push(a);
    }
  }

  // Join rather than take [0]: an unquoted question arrives pre-split by the
  // shell, and rejecting that would fail a worker at exactly the moment it is
  // trying to tell the operator it is stuck.
  const question = positional.join(" ").trim();
  if (!question) throw new Error(USAGE);

  const { project, worker } = resolveTarget(workerArg);
  const result = blockWorker(project, worker, question);
  if (!result.ok) throw new Error(result.message);
  console.log(result.message);
}

// Explicit --worker goes through the shared forgiving resolver; otherwise the
// worker's own env identifies it. $GARDEN_PROJECT is a fast path only — a
// registry miss falls back to the resolver so a stale env var cannot strand a
// worker that is trying to report a blocker.
function resolveTarget(workerArg: string | undefined): { project: string; worker: string } {
  if (workerArg) {
    const { project, worker } = resolveWorkerArg(workerArg);
    return { project, worker };
  }
  const envWorker = process.env.GARDEN_WORKER;
  if (!envWorker) {
    throw new Error(
      `Not in a worker shell (GARDEN_WORKER not set). Name the worker: ${USAGE}`,
    );
  }
  const envProject = process.env.GARDEN_PROJECT;
  if (envProject && findWorkerByName(envProject, envWorker)) {
    return { project: envProject, worker: envWorker };
  }
  const { project, worker } = resolveWorkerArg(envWorker);
  return { project, worker };
}
