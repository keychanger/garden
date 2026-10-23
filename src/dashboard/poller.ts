// Poller coordinator: per-project event-driven dispatcher. Each project's
// poller runs in a hidden tmux window, blocks on a FIFO read, and on every
// poke runs one cycle of pollProject.
//
// State machine logic is no longer routed by a switch in this file —
// pollWorker reads the worker's workflow from the registry and dispatches
// through workflow.stateHandlers. The default workflow points at the
// existing handlers in poller-state/review/merge/resolve. See WORKFLOWS.md
// Component 5a and src/dashboard/workflows/.
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  newDashboardWindowPaned, windowExists, windowIndices, killWindowsByName, dedupeWindows, shellEscape,
  setPaneVar, paneRunningOnlyShell, tmuxOutput,
} from "./tmux.js";
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
import { resolveGardenRunner } from "./runner.js";
import {
  signalFifoPath, ensureSignalFifo, triggerProjectPoll, pollerSpawnLockPath,
} from "./poller-fifo.js";
import { withFileLock } from "./file-lock.js";
import { getWorkflow } from "./workflows/index.js";
import { processPendingHandoffs } from "./handoff-dispatch.js";
import { runBeadIntake } from "./poller-intake.js";

// Re-exports of the public API consumed elsewhere in the codebase.
// External callers continue to import from "./poller" — the split is
// internal-only.
export { triggerProjectPoll, signalFifoPath } from "./poller-fifo.js";
export { autoContinueGateReason, checkUsageThreshold } from "./poller-merge.js";
export { killReviewWindow } from "./poller-review.js";
export { killCiFixWindow } from "./poller-ci-fix.js";

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
    const cmd = pollerLoopCommand(projectName, gardenRunner);
    const paneId = newDashboardWindowPaned(window, "bash", "-c", cmd);
    setPaneVar(paneId, POLLER_LOOP_VAR, pollerLoopStamp(cmd));

    log.info("poller", "started", { data: { project: projectName } });
  }, { name: `poller-spawn:${projectName}` });
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
export function pollerLoopCommand(projectName: string, gardenRunner: string): string {
  return [
    `exec 3<>${shellEscape(signalFifoPath(projectName))};`,
    `while true; do`,
    `  ${gardenRunner} dashboard _poll ${shellEscape(projectName)} 2>/dev/null;`,
    `  read -u 3 2>/dev/null || true;`,
    `done`,
  ].join(" ");
}

// Pane option holding a hash of the loop command the poller window runs.
const POLLER_LOOP_VAR = "garden_poller_loop";

function pollerLoopStamp(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

// Pane id and loop stamp of every pane in the dashboard session, by window
// name. Throws when tmux does not answer, so a caller never reads an
// unreachable server as "no pollers".
function pollerLoopStamps(): Map<string, { paneId: string; stamp: string }[]> {
  const byWindow = new Map<string, { paneId: string; stamp: string }[]>();
  const out = tmuxOutput(
    "list-panes", "-s", "-t", DASHBOARD_SESSION,
    "-F", `#{window_name}\t#{pane_id}\t#{@${POLLER_LOOP_VAR}}`,
  );
  for (const line of out.split("\n")) {
    const [windowName, paneId, stamp = ""] = line.split("\t");
    if (!windowName || !paneId) continue;
    const panes = byWindow.get(windowName) ?? [];
    panes.push({ paneId, stamp });
    byWindow.set(windowName, panes);
  }
  return byWindow;
}

// A running poller pins nothing but its loop command: every pass execs a
// fresh `dashboard _poll`, so a rebuild reaches it at the next poll without a
// restart, and a restart mid-poll cuts a rebase, push, or merge finalization
// short. So a poller is restarted only when the command it runs differs from
// the one this build would start — a moved runner path, a changed loop, or a
// window older than the stamp — and only while it waits between polls. A busy
// one is left for the watchdog's next tick.
export function restartDriftedPollers(projects: Iterable<string>, gardenRunner: string): void {
  let panes: Map<string, { paneId: string; stamp: string }[]>;
  try {
    panes = pollerLoopStamps();
  } catch (err) {
    log.debug("poller", "skipped poller drift check: tmux did not answer", {
      data: { error: String(err) },
    });
    return;
  }
  for (const projectName of projects) {
    try {
      const live = panes.get(pollerWindowName(projectName));
      // None is the heal's to spawn; duplicates are startProjectPoller's to collapse.
      if (live?.length !== 1) continue;
      const [{ paneId, stamp }] = live;
      if (stamp === pollerLoopStamp(pollerLoopCommand(projectName, gardenRunner))) continue;
      if (!paneRunningOnlyShell(paneId)) {
        log.debug("poller", "deferred drifted poller restart: mid-poll", {
          data: { project: projectName },
        });
        continue;
      }
      stopProjectPoller(projectName);
      startProjectPoller(projectName, gardenRunner);
      log.info("poller", "restarted poller on a changed loop command", {
        data: { project: projectName, previousStamp: stamp || "(none)" },
      });
    } catch (err) {
      log.warn("poller", "failed to restart drifted project poller", {
        data: { project: projectName, error: String(err) },
      });
    }
  }
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

// Restart the two processes that keep the build they started with in memory —
// the usage poller and the watchdog — plus any project poller whose loop
// command drifted (restartDriftedPollers). Project pollers go first: the
// restarted watchdog's first tick pokes every intake project, and a poke that
// lands in a kill→spawn gap is dropped (the next event re-pokes).
export function restartLongLivedPollers(gardenRunner: string): void {
  try {
    const registry = readRegistry();
    const config = loadConfig();
    const projects = new Set(
      Object.entries(registry.workers)
        .filter(([, entries]) => entries.length > 0)
        .map(([projectName]) => projectName),
    );
    for (const [projectName, project] of Object.entries(config.projects)) {
      if (project.beadIntake === true) projects.add(projectName);
    }
    restartDriftedPollers(projects, gardenRunner);
  } catch (err) {
    log.warn("poller", "failed to check project pollers for drift", { data: { error: String(err) } });
  }

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
}
