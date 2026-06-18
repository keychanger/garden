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
  findWorkerByName, updateWorkerFields,
  type WorkerEntry, type PrState, type WorkerFieldsUpdate,
} from "./registry.js";
import { scheduleDelayedPoke } from "./poller-fifo.js";
import { getValidTransitions } from "./workflows/types.js";
import {
  maybeDispatchHolisticReview, evaluateHolisticGate, finalizeShadowHolistic,
} from "./poller-holistic-review.js";

export const DEBOUNCE_MS = 30_000;

export function transitionState(
  projectName: string,
  workerName: string,
  toState: PrState,
  extraFields?: Omit<WorkerFieldsUpdate, "prState">,
): void {
  const entry = findWorkerByName(projectName, workerName);
  const fromState: PrState = entry?.prState ?? "working";
  const workflowName = entry?.workflow ?? "default";
  const validTransitions = getValidTransitions(workflowName);
  if (!validTransitions[fromState]?.includes(toState)) {
    log.warn("poller", `invalid state transition: ${fromState} -> ${toState}`, {
      worker: workerName,
      // `requested` is the raw value on the registry entry (may be undefined
      // for legacy entries or a name unknown to the registry, in which case
      // getValidTransitions has already silently fallen back to default —
      // preserving the original value here makes that fallback visible).
      data: { project: projectName, workflow: workflowName, requested: entry?.workflow },
    });
  }
  updateWorkerFields(projectName, workerName, { ...extraFields, prState: toState });
  maybeFireHandoffCallback(projectName, workerName, toState);
}

// One-shot callback dispatch for handoff children that requested it via
// `garden handoff --expect-callback`. Fires when the child reaches its first
// terminal prState (merged/done/failing). Idempotent: handoffCallbackFiredAt
// is set before the dispatch so a replayed transition (rare: terminal state
// re-write within the same merge cycle) doesn't double-fire. Hooked here
// rather than at each individual call site so every path that lands on a
// terminal state — finalizeMerge's `merged`/`done`, every poller-review
// failing transition, the resolver's failing transition — is covered by
// one chokepoint.
function maybeFireHandoffCallback(
  projectName: string,
  workerName: string,
  toState: PrState,
): void {
  if (toState !== "merged" && toState !== "done" && toState !== "failing") return;
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return;
  if (!entry.handoffCallbackExpected) return;
  if (entry.handoffCallbackFiredAt) return;
  if (!entry.parentProject || !entry.parentWorker) return;

  // Mark fired BEFORE dispatch under the registry lock. notifyHandoffCallback
  // is best-effort — if the parent pane is gone or busy, it silently no-ops.
  // Either way, this callback was the one shot we get.
  updateWorkerFields(projectName, workerName, {
    handoffCallbackFiredAt: Date.now(),
  });

  // Lazy import: continue.ts depends on registry, and registry doesn't depend
  // on continue.ts. Static import here would be fine, but the lazy form keeps
  // poller-state.ts free of any UI-layer transitive imports for callers that
  // don't transition to a terminal state.
  void import("./continue.js").then(({ notifyHandoffCallback }) => {
    notifyHandoffCallback({
      childProject: projectName,
      childWorker: workerName,
      childBranch: entry.branchName,
      terminalState: toState,
      parentProject: entry.parentProject!,
      parentWorker: entry.parentWorker!,
      replyNote: entry.handoffReplyNote,
    });
  }).catch(err => {
    log.warn("poller", "handoff callback dispatch failed", {
      worker: workerName,
      data: { project: projectName, error: String(err) },
    });
  });
}

// failingReasons that require operator action — the failing → working push
// debounce does NOT apply. New commits don't auto-resume; only the
// corresponding `garden trellis ...` command (phase 4) clears the state.
// See WORKFLOWS.md "Equilibrium and termination": trellis-flagged needs
// `garden trellis resume`; iteration-budget needs `garden trellis budget`
// or kill; stagnation (v1.5) needs amend or kill.
function requiresOperatorAction(entry: WorkerEntry): boolean {
  switch (entry.failingReason) {
    case "trellis-flagged":
    case "iteration-budget":
    case "stagnation":
      return true;
    default:
      return false;
  }
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
    // A SHADOW holistic worker reaching quiescent done (it analyzed, wrote
    // findings, and did not commit): surface its findings and consume them.
    // Fix-mode holistic workers commit, so they go through review/merge and
    // never land here.
    if ((entry.workflow ?? "default") === "holistic-review") {
      finalizeShadowHolistic(projectName, entry);
      return false;
    }
    // Quiescent done. This is the trail-off holistic trigger site: a worker
    // that finished a multi-phase task WITHOUT a final merge reached `done` via
    // the Stop hook (hooks/default.ts), bypassing transitionToTerminal — so
    // this is the only place its holistic review can fire. Gate to eligible-only
    // (the high-water guard then makes it once-per-arrival) so a quiescent done
    // worker re-poked by sibling events doesn't re-evaluate every poke.
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
