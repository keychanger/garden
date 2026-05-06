// State machine: transitionState (registry-routed) and the simple state
// handlers that don't launch subprocesses (handleFailing, handleMerged,
// handleDone). The lifecycle handlers that DO launch subprocesses live in
// poller-review / poller-merge / poller-resolve and import transitionState
// from this module. Valid transitions are now defined per-workflow on
// WorkflowDefinition.validTransitions; the default workflow's table is the
// literal copy of the pre-refactor VALID_TRANSITIONS constant.
import { addAlert } from "./alerts.js";
import {
  getBranchHeadSha, getCommitSummary, getNewCommitSummary,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields,
  type WorkerEntry, type PrState,
} from "./registry.js";
import { scheduleDelayedPoke } from "./poller-fifo.js";
import { getWorkflow } from "./workflows/index.js";

export const DEBOUNCE_MS = 30_000;

export function transitionState(
  projectName: string,
  workerName: string,
  toState: PrState,
  extraFields?: Partial<Omit<WorkerEntry, "name" | "prState">>,
): void {
  const entry = findWorkerByName(projectName, workerName);
  const fromState: PrState = entry?.prState ?? "working";
  const workflow = getWorkflow(entry?.workflow ?? "default");
  if (!workflow.validTransitions[fromState]?.includes(toState)) {
    log.warn("poller", `invalid state transition: ${fromState} -> ${toState}`, {
      worker: workerName,
      // `requested` is the raw value on the registry entry (may be undefined
      // for legacy entries or a name unknown to the registry, in which case
      // getWorkflow has already silently fallen back to default — preserving
      // the original value here makes that fallback visible in logs).
      data: { workflow: workflow.name, requested: entry?.workflow },
    });
  }
  updateWorkerFields(projectName, workerName, { ...extraFields, prState: toState });
}

export function handleFailing(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  if (!headSha) return false;

  if (headSha !== entry.lastSeenSha) {
    // New commits pushed — track the change
    const commitLog = getNewCommitSummary(wtPath, entry.failingSha ?? entry.lastSeenSha);
    if (commitLog) {
      log.info("poller", "new commits in failing worker", {
        worker: entry.name,
        data: { commits: commitLog },
      });
    }

    updateWorkerFields(projectName, entry.name, {
      lastSeenSha: headSha,
      lastShaChangeAt: new Date().toISOString(),
    });
    // Schedule a one-shot wake-up so the debounce check fires after DEBOUNCE_MS.
    // Without this, the event-driven poller sleeps on the FIFO indefinitely —
    // nothing else pokes it, so the failing → working transition never fires.
    scheduleDelayedPoke(projectName, DEBOUNCE_MS);
    return false;
  }

  // If failingSha is set, new commits are required before retrying.
  if (entry.failingSha && headSha === entry.failingSha) {
    return false;
  }

  // Check debounce timeout
  const changeAt = entry.lastShaChangeAt ? new Date(entry.lastShaChangeAt).getTime() : 0;
  if (Date.now() - changeAt >= DEBOUNCE_MS) {
    log.info("poller", "debounce complete, retrying", { worker: entry.name });

    if ((entry.failCount ?? 0) >= 3) {
      addAlert({
        level: "error",
        source: "poller",
        project: projectName,
        worker: entry.name,
        message: `Worker ${entry.name} has failed ${entry.failCount} times -- may need manual attention`,
      });
    }

    transitionState(projectName, entry.name, "working", {
      failingSha: undefined,
      failingReason: undefined,
      lastSeenSha: undefined,
    });
    return true;
  }
  return false;
}

// projectPath parameter is unused — handlers take a uniform signature so the
// workflow registry can dispatch them through one interface (see workflows/types.ts).
export function handleMerged(
  projectName: string,
  _projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath;
  if (!wtPath) return false;

  // Recovery path: if commits appear before UserPromptSubmit clears the
  // transient `merged`, treat that as a new work cycle and resume.
  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (!commitSummary) return false;

  log.info("poller", "new commits after merge, resuming", {
    worker: entry.name,
  });
  transitionState(projectName, entry.name, "working", {
    mergedAt: undefined,
    lastSeenSha: undefined,
  });
  refreshDashboard();
  return true;
}

// Mirror of handleMerged for the terminal "done" cleanup signal. Symmetric
// behavior: if the operator nudges the worker into a new work cycle (commits
// appear) without going through UserPromptSubmit, recover into `working`.
export function handleDone(
  projectName: string,
  _projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath;
  if (!wtPath) return false;
  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (!commitSummary) return false;
  log.info("poller", "new commits after done, resuming", { worker: entry.name });
  transitionState(projectName, entry.name, "working", {
    mergedAt: undefined,
    lastSeenSha: undefined,
  });
  refreshDashboard();
  return true;
}
