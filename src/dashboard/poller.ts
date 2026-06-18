// Poller coordinator: per-project event-driven dispatcher. Each project's
// poller runs in a hidden tmux window, blocks on a FIFO read, and on every
// poke runs one cycle of pollProject.
//
// State machine logic is no longer routed by a switch in this file —
// pollWorker reads the worker's workflow from the registry and dispatches
// through workflow.stateHandlers. The default workflow points at the
// existing handlers in poller-state/review/merge/resolve. See WORKFLOWS.md
// Component 5a and src/dashboard/workflows/.
import fs from "node:fs";
import { tmux, windowExists, windowIndices, killWindowsByName, dedupeWindows, shellEscape } from "./tmux.js";
import {
  readRegistry, getWorkers, type WorkerEntry,
} from "./registry.js";
import { tryGetProject, loadConfig } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { getWorkerBaseBranch } from "./git.js";
import { healStatusPane, sweepGhostEntries } from "./validate.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import { pollerWindowName } from "./window-names.js";
import { stopUsagePoller, startUsagePoller } from "./usage-poller.js";
import { stopWatchdog, startWatchdog } from "./watchdog.js";
import {
  signalFifoPath, ensureSignalFifo, triggerProjectPoll, pollerSpawnLockPath,
} from "./poller-fifo.js";
import { withFileLock } from "./file-lock.js";
import { getWorkflow } from "./workflows/index.js";
import { processPendingHandoffs } from "./handoff-dispatch.js";

// Re-exports of the public API consumed elsewhere in the codebase.
// External callers continue to import from "./poller" — the split is
// internal-only.
export { triggerProjectPoll, signalFifoPath } from "./poller-fifo.js";
export { autoContinueGateReason, checkUsageThreshold } from "./poller-merge.js";
export { killReviewWindow } from "./poller-review.js";

// Main poll entry point — called by `garden dashboard _poll <project>`
export function poll(projectName: string): boolean {
  healStatusPane();
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
  return pollProject(projectName);
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
  // WorkflowDefinition.stateHandlers is Record<PrState, StateHandler> — the
  // type contract guarantees a handler for every state, so no runtime guard
  // is needed. A new PrState in registry.ts would be a TypeScript error here
  // until every workflow declares a handler for it.
  return workflow.stateHandlers[state](projectName, projectPath, baseBranch, entry);
}

// --- Per-project poller lifecycle ---

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

export function startProjectPoller(projectName: string, gardenRunner: string): void {
  const window = pollerWindowName(projectName);
  // Serialize the check-and-spawn across the dashboard's federation of
  // independent processes (watchdog heal, post-rebuild restartLongLivedPollers,
  // validate-on-attach, worker create). The windowIndices snapshot below is
  // only a read, not a claim: without a cross-process lock two starters can
  // both observe zero windows and both reach `new-window`, leaving a duplicate
  // that the next watchdog tick must collapse (logging "collapsed duplicate
  // poller windows"). The FIFO's mkfifo election does NOT cover this — it elects
  // a winner only when the FIFO is absent, but the FIFO file persists on disk
  // after an unclean poller death (only stopProjectPoller unlinks it), so the
  // common respawn case has no election at all. Holding this lock around the
  // whole check-and-spawn closes the window: the second caller acquires the
  // lock only after the first's new-window has registered with the tmux server,
  // so its windowIndices read sees one window and it no-ops.
  withFileLock(pollerSpawnLockPath(projectName), () => {
    // Convergent: spawn when no poller window exists, collapse to one when a
    // prior spawn race left duplicates, no-op when exactly one is live. Resolve
    // by index, not the `windowExists` name probe, so duplicates are counted
    // rather than mistaken for "dead" (the bug that drove the respawn runaway).
    const existing = windowIndices(window);
    if (existing.length > 0) {
      if (existing.length > 1) {
        const killed = dedupeWindows(window);
        log.warn("poller", "collapsed duplicate poller windows", {
          data: { project: projectName, killed },
        });
      }
      return;
    }

    const fifo = signalFifoPath(projectName);
    if (!ensureSignalFifo(fifo)) {
      // Another process won the FIFO-creation race and is spawning this poller
      // right now. With the spawn lock held this is now unreachable in practice,
      // but keep it as a defensive second gate.
      log.debug("poller", "deferred poller spawn to concurrent starter", {
        data: { project: projectName },
      });
      return;
    }
    // Event-driven poller loop: poll once, then block on the FIFO until an
    // event arrives. Per STATUS.md invariant 6, there is no fallback poll.
    // Every transition is delivered by an event from one of these sources:
    // Claude Code hooks, worker push hook, merge queue completion, tmux
    // pane-died, or the auto-continue gate-reset wake (usage poller /
    // `garden auto on`). The poller is a pure dispatcher that does one unit
    // of work per wake.
    //
    // `exec 3<>${fifo}` holds the FIFO open in R+W mode for the loop's whole
    // lifetime (not just the per-iteration `read`). Without this, the FIFO has
    // no reader during `_poll`'s execution — which is exactly when lifecycle
    // handlers fire scheduleDelayedPoke. The handler's detached writer would
    // open R+W, write, close, and the byte would be reclaimed by the kernel
    // before the loop's next `read` opened the FIFO again. Persistent fd 3
    // keeps a reader present so buffered bytes survive until consumed.
    const cmd = [
      `exec 3<>${shellEscape(fifo)};`,
      `while true; do`,
      `  ${gardenRunner} dashboard _poll ${shellEscape(projectName)} 2>/dev/null;`,
      `  read -u 3 2>/dev/null || true;`,
      `done`,
    ].join(" ");
    tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", window,
      "bash", "-c", cmd);

    log.info("poller", "started", { data: { project: projectName } });
  }, { name: `poller-spawn:${projectName}` });
}

export function stopProjectPoller(projectName: string): void {
  const window = pollerWindowName(projectName);
  // Kill all windows of this name (by index), not just one — a prior spawn
  // race may have left duplicates, and a single name-targeted kill can't
  // remove them (the target is ambiguous).
  killWindowsByName(window);
  const fifo = signalFifoPath(projectName);
  try { fs.unlinkSync(fifo); } catch { /* ignore */ }
  log.info("poller", "stopped", { data: { project: projectName } });
}

export function stopAllPollers(): void {
  const config = loadConfig();
  for (const projectName of Object.keys(config.projects)) {
    stopProjectPoller(projectName);
  }
}

export function ensureProjectPoller(projectName: string, gardenRunner: string): void {
  if (projectPollerRunning(projectName)) return;
  startProjectPoller(projectName, gardenRunner);
}

export function projectPollerRunning(projectName: string): boolean {
  return windowExists(pollerWindowName(projectName));
}

// Pokes that land during the brief kill→spawn gap are dropped; the next event re-pokes.
export function restartLongLivedPollers(gardenRunner: string): void {
  try {
    stopUsagePoller();
    startUsagePoller(gardenRunner);
  } catch (err) {
    log.warn("poller", "failed to restart usage poller", { data: { error: String(err) } });
  }

  try {
    stopWatchdog();
    startWatchdog(gardenRunner);
  } catch (err) {
    log.warn("poller", "failed to restart watchdog", { data: { error: String(err) } });
  }

  const registry = readRegistry();
  for (const [projectName, entries] of Object.entries(registry.workers)) {
    if (entries.length === 0) continue;
    try {
      stopProjectPoller(projectName);
      startProjectPoller(projectName, gardenRunner);
    } catch (err) {
      log.warn("poller", "failed to restart project poller", {
        data: { project: projectName, error: String(err) },
      });
    }
  }
}
