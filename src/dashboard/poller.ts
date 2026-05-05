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
import { tmux, windowExists, killWindowSafe } from "./tmux.js";
import {
  readRegistry, getWorkers, type WorkerEntry,
} from "./registry.js";
import { tryGetProject, loadConfig } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { getWorkerBaseBranch } from "./git.js";
import { healStatusPane } from "./validate.js";
import { log } from "./log.js";
import { pollerWindowName } from "./window-names.js";
import { stopUsagePoller, startUsagePoller } from "./usage-poller.js";
import {
  signalFifoPath, ensureSignalFifo, triggerProjectPoll,
} from "./poller-fifo.js";
import { getWorkflow } from "./workflows/index.js";

// Re-exports of the public API consumed elsewhere in the codebase.
// External callers continue to import from "./poller" — the split is
// internal-only.
export { triggerProjectPoll, signalFifoPath } from "./poller-fifo.js";
export { autoContinueGateReason, checkUsageThreshold } from "./poller-merge.js";
export { killReviewWindow } from "./poller-review.js";

// Main poll entry point — called by `garden dashboard _poll <project>`
export function poll(projectName: string): boolean {
  healStatusPane();
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
        data: { error: String(err) },
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
  const handler = workflow.stateHandlers[state];
  if (!handler) {
    log.warn("poller", "no handler for state in workflow", {
      worker: entry.name,
      data: { state, workflow: workflow.name },
    });
    return false;
  }
  return handler(projectName, projectPath, baseBranch, entry);
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
  if (windowExists(window)) return;

  const fifo = signalFifoPath(projectName);
  ensureSignalFifo(fifo);
  const escapedFifo = fifo.replace(/'/g, "'\\''");
  const escapedProject = projectName.replace(/'/g, "'\\''");
  // Event-driven poller loop: poll once, then block on the FIFO until an
  // event arrives. Per STATUS.md invariant 6, there is no fallback poll.
  // Every transition is delivered by an event from one of four sources:
  // Claude Code hooks, worker push hook, merge queue completion, or tmux
  // pane-died. The poller is a pure dispatcher that does one unit of work
  // per wake.
  const cmd = [
    `while true; do`,
    `  ${gardenRunner} dashboard _poll '${escapedProject}' 2>/dev/null;`,
    `  read <>'${escapedFifo}' 2>/dev/null || true;`,
    `done`,
  ].join(" ");
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", window,
    "bash", "-c", cmd);

  log.info("poller", "started", { data: { project: projectName } });
}

export function stopProjectPoller(projectName: string): void {
  const window = pollerWindowName(projectName);
  killWindowSafe(window);
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
