// Poller coordinator: per-project event-driven dispatcher. Each project's
// poller runs in a hidden tmux window, blocks on a FIFO read, and on every
// poke runs one cycle of pollProject.
//
// State machine logic is no longer routed by a switch in this file —
// pollWorker reads the worker's workflow from the registry and dispatches
// through workflow.stateHandlers. The default workflow points at the
// existing handlers in poller-state/review/merge/resolve. See WORKFLOWS.md
// Component 5a and src/dashboard/workflows/.
import {
  getWorkers, type WorkerEntry,
} from "./registry.js";
import { tryGetProject, loadConfig } from "../config.js";
import { addAlert } from "./alerts.js";
import { getWorkerBaseBranch } from "./git.js";
import { healStatusPane, sweepGhostEntries } from "./validate.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import { startWatchdog } from "./watchdog.js";
import { resolveGardenRunner } from "./runner.js";
import { triggerProjectPoll } from "./poller-fifo.js";
import { getWorkflow } from "./workflows/index.js";
import { processPendingHandoffs } from "./handoff-dispatch.js";
import { runBeadIntake } from "./poller-intake.js";
import { syncEditsUnwatchedMarker } from "./poller-state.js";

// Re-exports of the public API consumed elsewhere in the codebase.
// External callers continue to import from "./poller" — the split is
// internal-only. The window lifecycle lives in poller-window.ts, and the
// modules this file's own imports reach (workers, validate, create) must
// import it from there: importing it from here closes a cycle with every
// state handler.
export { triggerProjectPoll, signalFifoPath } from "./poller-fifo.js";
export { autoContinueGateReason, checkUsageThreshold } from "./poller-merge.js";
export {
  startProjectPoller, pollerLoopCommand, restartDriftedPollers, stopProjectPoller,
  stopAllPollers, ensureProjectPoller, projectPollerRunning, restartLongLivedPollers,
  killReviewWindow, killCiFixWindow,
} from "./poller-window.js";

// Main poll entry point — called by `garden dashboard _poll <project>`
export function poll(projectName: string): boolean {
  healStatusPane();
  // The watchdog respawns dead project pollers, but nothing respawned the
  // watchdog: once its window died, every duty it owns — poller healing,
  // stranded-worker re-pokes, sleep discounting, the review-timeout backstop —
  // stayed dead until the next dashboard attach or rebuild. Observed
  // 2026-08-28: watchdog and two project pollers gone together, a worker
  // unprocessed for hours and a review timeout fired 40 min late. Pollers
  // are the fleet's other long-lived processes, so each poll re-arms the
  // watchdog when its window is missing (startWatchdog is a no-op otherwise).
  try {
    startWatchdog(resolveGardenRunner());
  } catch (err) {
    log.warn("poller", "failed to ensure watchdog", { data: { error: String(err) } });
  }
  // Sweep ghost registry entries cross-project. validateAndHeal already does
  // this at attach time, but mid-session ghosts (e.g. a fan-out handoff with
  // partial bootstrap failures) would otherwise linger and keep the plot
  // strip's working spinner lit until the next dashboard restart.
  try {
    if (sweepGhostEntries()) refreshDashboard();
  } catch (err) {
    log.error("poller", "sweepGhostEntries failed", {
      data: { error: String(err) },
    });
  }
  // Pick up handoff requests submitted by sandboxed workers (see
  // handoff-dispatch.ts). Cross-project: pollers are global pickers, not
  // tied to the request's target project — any wake on any project drains
  // pending handoffs.
  try {
    processPendingHandoffs();
  } catch (err) {
    log.error("poller", "processPendingHandoffs failed", {
      data: { error: String(err) },
    });
  }
  const changed = pollProject(projectName);
  // Bead-intake step (board→garden delegation): converts ready,
  // dispatch-labeled beads into workers for projects opted in via
  // `beadIntake: true`. Runs after the lifecycle pass so review/merge work is
  // never delayed behind bd shell-outs; throttled internally (explicit
  // `garden poke` bypasses the throttle). See poller-intake.ts.
  let intakeChanged = false;
  try {
    const project = tryGetProject(projectName);
    if (project) intakeChanged = runBeadIntake(projectName, project);
  } catch (err) {
    log.error("poller", "bead intake failed", {
      data: { project: projectName, error: String(err) },
    });
  }
  return changed || intakeChanged;
}

function pollProject(projectName: string): boolean {
  const project = tryGetProject(projectName);
  if (!project) return false;

  const workers = getWorkers(projectName);
  let changed = false;

  // Debug: fires on every FIFO poke, most of which produce no transition.
  // Real state changes log at info via updateWorkerFields (registry.ts).
  log.debug("poller", "poll cycle", {
    data: { project: projectName, workers: workers.map(w => w.name) },
  });

  for (const entry of workers) {
    // baseBranch is pinned per-worker at creation (entry.baseBranch); legacy
    // workers without the field fall back to the current main-checkout branch.
    const baseBranch = getWorkerBaseBranch(entry, project.path);
    try {
      if (pollWorker(projectName, project.path, baseBranch, entry)) {
        changed = true;
      }
    } catch (err) {
      log.error("poller", "error polling worker", {
        worker: entry.name,
        data: { project: projectName, error: String(err) },
      });
    }
  }

  return changed;
}

function pollWorker(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // pollWorker is called when the FIFO is poked. It dispatches on prState
  // through the worker's workflow and runs one unit of work. Per STATUS.md
  // invariant 6, every transition is event-triggered — pollWorker never
  // schedules a re-check.
  const state = entry.prState ?? "working";
  const workflow = getWorkflow(entry.workflow ?? "default");
  // WorkflowDefinition.stateHandlers is Record<PrState, StateHandler>, so a
  // new PrState in registry.ts is a TypeScript error here until every workflow
  // declares a handler for it. The registry guard, though, checks only that
  // prState is a string, so a state from a newer build, a hand-edit, or a
  // worker's write arrives with no handler. Skip that worker rather than throw
  // on every poll, and leave its entry as written so a build that knows the
  // state can still act on it. hasOwn, because a plain lookup also finds
  // Object.prototype members ("constructor") on the handler table.
  if (!Object.hasOwn(workflow.stateHandlers, state)) {
    log.warn("poller", "unknown prState, skipping worker", {
      worker: entry.name,
      data: { project: projectName, workflow: workflow.name, prState: state },
    });
    return false;
  }
  // Every handler runs its git, and launches its agents, in the worker's
  // worktree. Without a path to it (validate.ts clears the field once the
  // directory is gone) they fell back to the project checkout: the operator's
  // own working directory, where the merge queue runs `git checkout -- .`,
  // rebases, and force-pushes. This is the only way into the handlers, so the
  // refusal lives here rather than at each of their fallbacks.
  if (!entry.worktreePath) {
    // Say so only when the entry has pipeline work waiting. An idle or
    // finished one has none, and the alert would otherwise repeat every hour
    // for as long as the entry stays registered.
    if (entry.pendingReviewAt !== undefined || !["working", "merged", "done"].includes(state)) {
      addAlert({
        level: "warn",
        source: "poller",
        project: projectName,
        worker: entry.name,
        message: `Worker ${entry.name} has no worktree path in the registry, so garden is not reviewing `
          + `or merging it, rather than doing that in the project checkout. Its branch is untouched. `
          + `\`garden workers stop ${entry.name}\` removes it, and \`garden resurrect ${entry.name}\` `
          + `can then rebuild it.`,
        dedupKey: `worktree-missing:${projectName}:${entry.name}`,
      });
    }
    return false;
  }
  const changed = workflow.stateHandlers[state](projectName, projectPath, baseBranch, entry);
  syncEditsUnwatchedMarker(projectName, entry.name);
  return changed;
}

// --- Poll triggers (the poller windows themselves: poller-window.ts) ---

export function postPush(projectName?: string): void {
  if (projectName) {
    triggerProjectPoll(projectName);
  } else {
    triggerAllPollers();
  }
}

function triggerAllPollers(): void {
  const config = loadConfig();
  for (const projectName of Object.keys(config.projects)) {
    triggerProjectPoll(projectName);
  }
}
