import { readRegistry, findWorkerByName, compareWorkerFreshness, type WorkerEntry } from "../dashboard/registry.js";
import { output, isTTY } from "../output.js";
import { resolveWorkerStatus } from "./status.js";

interface WhoamiResult {
  project: string;
  worker: string;
  branch?: string;
  baseBranch?: string;
  role?: string;
  parentWorker?: string;
  worktreePath?: string;
  sessionId: string;
  prState?: string;
  agentStatus?: string;
  displayStatus: string;
  task?: string;
  pendingReviewAt?: string;
  reviewStartedAt?: string;
  mergedAt?: string;
  failCount?: number;
  siblings: Array<{ name: string; displayStatus: string }>;
}

export async function whoami(args: string[]): Promise<void> {
  const explicit = args[0];
  const project = process.env.GARDEN_PROJECT;
  const worker = explicit ?? process.env.GARDEN_WORKER;

  if (!worker) {
    throw new Error(
      "Not in a worker shell (GARDEN_WORKER not set). Pass a worker name: garden whoami <worker>",
    );
  }

  const registry = readRegistry();
  let resolvedProject = project;
  let entry: WorkerEntry | undefined;

  if (resolvedProject) {
    entry = findWorkerByName(resolvedProject, worker);
  }
  if (!entry) {
    for (const [p, entries] of Object.entries(registry.workers)) {
      const match = entries.find(e => e.name === worker);
      if (match) {
        resolvedProject = p;
        entry = match;
        break;
      }
    }
  }

  if (!entry || !resolvedProject) {
    throw new Error(`Worker '${worker}' not found in registry.`);
  }

  const siblings = (registry.workers[resolvedProject] ?? [])
    .filter(e => e.name !== entry!.name)
    .sort(compareWorkerFreshness)
    .map(e => ({ name: e.name, displayStatus: resolveWorkerStatus(e) }));

  const result: WhoamiResult = {
    project: resolvedProject,
    worker: entry.name,
    branch: entry.branchName,
    baseBranch: entry.baseBranch,
    role: entry.role,
    parentWorker: entry.parentWorker,
    worktreePath: entry.worktreePath,
    sessionId: entry.sessionId,
    prState: entry.prState,
    agentStatus: entry.agentStatus,
    displayStatus: resolveWorkerStatus(entry),
    task: entry.task || undefined,
    pendingReviewAt: entry.pendingReviewAt ? new Date(entry.pendingReviewAt).toISOString() : undefined,
    reviewStartedAt: entry.reviewStartedAt ? new Date(entry.reviewStartedAt).toISOString() : undefined,
    mergedAt: entry.mergedAt,
    failCount: entry.failCount,
    siblings,
  };

  if (!isTTY) {
    output(result);
    return;
  }

  console.log("");
  console.log(`  \x1b[1m${result.project}/${result.worker}\x1b[0m  \x1b[2m(${result.displayStatus})\x1b[0m`);
  console.log("");
  if (result.branch) console.log(`    branch       ${result.branch} \x1b[2m→ ${result.baseBranch ?? "main"}\x1b[0m`);
  if (result.worktreePath) console.log(`    worktree     ${result.worktreePath}`);
  if (result.role) console.log(`    role         ${result.role}${result.parentWorker ? ` (parent: ${result.parentWorker})` : ""}`);
  if (result.task) console.log(`    task         ${result.task}`);
  if (result.agentStatus) console.log(`    claude       ${result.agentStatus}`);
  if (result.prState) console.log(`    pr           ${result.prState}`);
  if (result.pendingReviewAt) console.log(`    review queued ${result.pendingReviewAt}`);
  if (result.reviewStartedAt) console.log(`    review running since ${result.reviewStartedAt}`);
  if (result.mergedAt) console.log(`    merged       ${result.mergedAt}`);
  if (result.failCount) console.log(`    fail count   ${result.failCount}`);

  if (result.siblings.length > 0) {
    console.log("");
    console.log(`    siblings (${result.siblings.length}):`);
    for (const s of result.siblings) {
      console.log(`      - ${s.name}  \x1b[2m(${s.displayStatus})\x1b[0m`);
    }
  }
  console.log("");
  console.log("    \x1b[2mgarden logs -w " + result.worker + "  # your history\x1b[0m");
  console.log("");
}
