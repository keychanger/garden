// State machine: VALID_TRANSITIONS, transitionState, and the simple state
// handlers that don't launch subprocesses (handleFailing, handleMerged,
// handleDone). The lifecycle handlers that DO launch subprocesses live in
// poller-review / poller-merge / poller-resolve and import transitionState
// from this module.
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

export const DEBOUNCE_MS = 30_000;

// Valid state transitions per STATUS.md. transitionState warns (but does not
// block) if a transition is not in this table, surfacing bugs in the log
// without breaking production.
export const VALID_TRANSITIONS: Record<PrState, PrState[]> = {
  working:         ["reviewing"],
  reviewing:       ["merge-pending", "working", "failing"],
  "merge-pending": ["merged", "done", "resolving", "working"],
  resolving:       ["merge-pending", "working", "failing"],
  failing:         ["working"],
  merged:          ["working", "done"],
  done:            ["working"],
};

export function transitionState(
  projectName: string,
  workerName: string,
  toState: PrState,
  extraFields?: Partial<Omit<WorkerEntry, "name" | "prState">>,
): void {
  const entry = findWorkerByName(projectName, workerName);
  const fromState: PrState = entry?.prState ?? "working";
  if (!VALID_TRANSITIONS[fromState]?.includes(toState)) {
    log.warn("poller", `invalid state transition: ${fromState} -> ${toState}`, { worker: workerName });
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
      lastSeenSha: undefined,
    });
    return true;
  }
  return false;
}

export function handleMerged(
  projectName: string,
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
