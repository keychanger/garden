// State machine: transitionState (registry-routed) and the simple state
// handlers that don't launch subprocesses (handleFailing, handleDone).
// The lifecycle handlers that DO launch subprocesses live in
// poller-review / poller-merge / poller-resolve and import transitionState
// from this module. Valid transitions are defined per-workflow in
// workflows/types.ts (a leaf module); transitionState reads them via
// getValidTransitions() rather than going through workflows/index.ts. That
// indirection breaks a module-init cycle that closed in earlier shapes
// of this code (see workflows/types.ts comment).
import { addAlert } from "./alerts.js";
import {
  getBranchHeadSha, getCommitSummary, getNewCommitSummary,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields, updateWorkerFieldsIf, OPERATOR_ACTION_FAILING_REASONS,
  type WorkerEntry, type PrState, type WorkerFieldsUpdate,
} from "./registry.js";
import { scheduleDelayedPoke } from "./poller-fifo.js";
import { recordStateTransition } from "./telemetry.js";
import { getValidTransitions } from "./workflows/types.js";
import {
  maybeDispatchHolisticReview, evaluateHolisticGate,
} from "./poller-holistic-review.js";

export const DEBOUNCE_MS = 30_000;

interface HandoffCallbackDispatch {
  childProject: string;
  childWorker: string;
  childBranch: string | undefined;
  terminalState: "merged" | "done" | "failing";
  parentProject: string;
  parentWorker: string;
  replyNote: string | undefined;
}

interface TransitionResult {
  applied: boolean;
  fromState: PrState;
  workflowName: string;
  requestedWorkflow?: string;
  createdAt?: number;
  callback: HandoffCallbackDispatch | null;
}

function callbackDispatchFor(
  projectName: string,
  workerName: string,
  entry: Readonly<WorkerEntry>,
  toState: PrState,
): HandoffCallbackDispatch | null {
  if (toState !== "merged" && toState !== "done" && toState !== "failing") return null;
  if (!entry.handoffCallbackExpected || entry.handoffCallbackFiredAt) return null;
  if (!entry.parentProject || !entry.parentWorker) return null;
  return {
    childProject: projectName,
    childWorker: workerName,
    childBranch: entry.branchName,
    terminalState: toState,
    parentProject: entry.parentProject,
    parentWorker: entry.parentWorker,
    replyNote: entry.handoffReplyNote,
  };
}

function dispatchHandoffCallback(callback: HandoffCallbackDispatch): void {
  void import("./continue.js").then(({ notifyHandoffCallback }) => {
    notifyHandoffCallback(callback);
  }).catch(err => {
    log.warn("poller", "handoff callback dispatch failed", {
      worker: callback.childWorker,
      data: { project: callback.childProject, error: String(err) },
    });
  });
}

function applyTransition(
  projectName: string,
  workerName: string,
  toState: PrState,
  extraFields?: Omit<WorkerFieldsUpdate, "prState">,
  allowInvalid = false,
): boolean {
  const now = Date.now();
  const result = updateWorkerFieldsIf<TransitionResult>(projectName, workerName, entry => {
    const fromState: PrState = entry.prState ?? "working";
    const workflowName = entry.workflow ?? "default";
    const valid = getValidTransitions(workflowName)[fromState]?.includes(toState) === true;
    if (!valid && !allowInvalid) {
      return {
        fields: null,
        result: {
          applied: false,
          fromState,
          workflowName,
          requestedWorkflow: entry.workflow,
          callback: null,
        },
      };
    }

    const callback = callbackDispatchFor(projectName, workerName, entry, toState);
    const stateFields: Omit<WorkerFieldsUpdate, "prState"> = toState !== fromState
      ? { ...extraFields, lastStateChangeAt: now }
      : { ...extraFields };
    if (callback) stateFields.handoffCallbackFiredAt = now;
    return {
      fields: { ...stateFields, prState: toState },
      result: {
        applied: true,
        fromState,
        workflowName,
        requestedWorkflow: entry.workflow,
        createdAt: entry.createdAt,
        callback,
      },
    };
  });

  if (!result) return false;
  if (!result.applied) {
    log.warn("poller", `invalid state transition: ${result.fromState} -> ${toState}`, {
      worker: workerName,
      data: {
        project: projectName,
        workflow: result.workflowName,
        requested: result.requestedWorkflow,
      },
    });
    return false;
  }
  if (toState !== result.fromState) {
    recordStateTransition(
      projectName,
      workerName,
      result.createdAt,
      result.workflowName,
      result.fromState,
      toState,
    );
  }
  if (result.callback) dispatchHandoffCallback(result.callback);
  return true;
}

export function transitionState(
  projectName: string,
  workerName: string,
  toState: PrState,
  extraFields?: Omit<WorkerFieldsUpdate, "prState">,
): boolean {
  return applyTransition(projectName, workerName, toState, extraFields);
}

export function forceTransitionState(
  projectName: string,
  workerName: string,
  toState: PrState,
  extraFields?: Omit<WorkerFieldsUpdate, "prState">,
): boolean {
  return applyTransition(projectName, workerName, toState, extraFields, true);
}

// The Stop hook's trail-off `done` write bypasses transitionState, so
// handleDone uses this sibling path to claim the same one-shot callback under
// the registry lock. Poller-driven terminal moves claim it in applyTransition.
function maybeFireHandoffCallback(
  projectName: string,
  workerName: string,
  toState: PrState,
): void {
  const now = Date.now();
  const callback = updateWorkerFieldsIf(projectName, workerName, entry => {
    const dispatch = callbackDispatchFor(projectName, workerName, entry, toState);
    return {
      fields: dispatch ? { handoffCallbackFiredAt: now } : null,
      result: dispatch,
    };
  });
  if (callback) dispatchHandoffCallback(callback);
}

// failingReasons that require operator action — the failing → working push
// debounce does NOT apply. New commits don't auto-resume; only the
// corresponding `garden trellis ...` command (phase 4) clears the state.
// See WORKFLOWS.md "Equilibrium and termination": trellis-flagged needs
// `garden trellis resume`; iteration-budget needs `garden trellis budget`
// or kill; stagnation (v1.5) needs amend or kill.
function requiresOperatorAction(entry: WorkerEntry): boolean {
  return OPERATOR_ACTION_FAILING_REASONS.has(entry.failingReason ?? "code");
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

  // Trellis dispositions that need operator action stay parked until the
  // operator runs the appropriate trellis command. Pushing more commits
  // doesn't auto-resume — the spec keeps trellis-flagged out of the
  // working-debounce loop deliberately.
  if (requiresOperatorAction(entry)) {
    return false;
  }

  if (headSha !== entry.lastSeenSha) {
    // New commits pushed — track the change
    const commitLog = getNewCommitSummary(wtPath, entry.failingSha ?? entry.lastSeenSha);
    if (commitLog) {
      log.info("poller", "new commits in failing worker", {
        worker: entry.name,
        data: { project: projectName, commits: commitLog },
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
    log.info("poller", "debounce complete, retrying", {
      worker: entry.name,
      data: { project: projectName },
    });

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
    // Hand off to handleWorking now. The transition itself emits no event, so
    // the review launch otherwise waited for the next unrelated poke — the
    // watchdog's 5-min stale re-poke in practice (observed 14 min on
    // 2026-08-28). Same 0 s re-poke the unparseable-verdict re-queue uses.
    scheduleDelayedPoke(projectName, 0);
    return true;
  }
  return false;
}

// Mirror of handleMerged's recovery leg (poller-merge.ts) for the terminal
// "done" cleanup signal. Symmetric behavior: if the operator nudges the
// worker into a new work cycle (commits appear) without going through
// UserPromptSubmit, recover into `working`.
//
// Handlers take a uniform signature so the workflow registry can dispatch them
// through one interface (see workflows/types.ts). projectPath is consumed here
// by the trail-off holistic-review dispatch below.
export function handleDone(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath;
  if (!wtPath) return false;
  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (!commitSummary) {
    // A --expect-callback handoff child that trailed off to `done` WITHOUT ever
    // merging reached this terminal state via the Stop-hook done-write
    // (hooks/default.ts), which bypasses transitionState — so its parent's
    // one-shot callback (normally fired from transitionState) was never
    // dispatched, leaving the parent waiting on a signal that never comes. Fire
    // it here, the poller-side sibling of that dispatch: this handler is the
    // guaranteed poller-context landing for a trail-off done (the Stop hook
    // pokes it), and maybeFireHandoffCallback is idempotent so a re-poke or a
    // child that already fired at merge is a safe no-op.
    maybeFireHandoffCallback(projectName, entry.name, "done");
    // Quiescent done. This is the trail-off holistic trigger site: a worker
    // that finished a multi-phase task WITHOUT a final merge reached `done` via
    // the Stop hook (hooks/default.ts), bypassing transitionToTerminal — so
    // this is the only place its holistic review can fire. Gate to eligible-only
    // (the high-water guard then makes it once-per-arrival) so a quiescent done
    // worker re-poked by sibling events doesn't re-evaluate every poke. The
    // dispatcher interposes the final review by re-opening done -> reviewing.
    if (evaluateHolisticGate(entry).eligible) {
      maybeDispatchHolisticReview(projectName, projectPath, baseBranch, entry, "trailoff-handleDone");
    }
    return false;
  }
  log.info("poller", "new commits after done, resuming", {
    worker: entry.name,
    data: { project: projectName },
  });
  transitionState(projectName, entry.name, "working", {
    mergedAt: undefined,
    lastSeenSha: undefined,
  });
  refreshDashboard();
  return true;
}
