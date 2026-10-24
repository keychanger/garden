// The windows the poller owns, as an API for the code that creates and
// removes workers: each project's poller window (start, ensure, stop, and the
// drift restart), the long-lived usage poller and watchdog, and the
// per-worker review and ci-fix windows that worker removal kills.
//
// Kept apart from poller.ts, the poll orchestrator, on purpose. poller.ts
// imports the workflow registry, handoff dispatch and bead intake, which reach
// every state handler and workers.ts; workers.ts, validate.ts and create.ts
// call this API. With both in one file, those modules closed one runtime
// import cycle with every handler. This file imports none of them, so its
// callers stay out of that cycle (test/integration/import-cycles.real.test.ts).
import { createHash } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "../config.js";
import { DASHBOARD_SESSION, dashboardReach } from "../session.js";
import { withFileLock } from "./file-lock.js";
import { codexStderrSidecar } from "./harness/codex-core.js";
import {
  ciFixPromptPath, ciFixResultPath, reviewPromptPath, reviewResultPath,
} from "./headless-paths.js";
import { log } from "./log.js";
import { ensureSignalFifo, pollerSpawnLockPath, signalFifoPath } from "./poller-fifo.js";
import { readRegistry } from "./registry.js";
import {
  dedupeWindows, killWindowSafe, killWindowsByName, newDashboardWindowPaned,
  paneRunningOnlyShell, setPaneVar, shellEscape, tmuxOutput, windowExists, windowIndices,
} from "./tmux.js";
import { startUsagePoller, stopUsagePoller } from "./usage-poller.js";
import { startWatchdog, stopWatchdog } from "./watchdog.js";
import { ciFixWindowName, pollerWindowName, reviewWindowName } from "./window-names.js";

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
// Claude Code hooks, worker push hook, merge queue completion, a launch
// wrapper recording its agent's exit, or the auto-continue gate-reset wake (usage poller /
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
  // The FIFO is the poller's only wake source and the poller holds it open, so
  // unlinking it under a poller that survived leaves that poller deaf: no poke
  // reaches it, and nothing recreates the path while its window exists. It
  // goes only once tmux answers that no poller window is left, or that no
  // dashboard is running. Inside an agent sandbox the socket is denied, the
  // kill below does nothing, and the window list reads empty.
  const reach = dashboardReach();
  if (reach.state === "unreachable") {
    log.warn("poller", "kept poll FIFO: tmux did not answer", {
      data: { project: projectName, error: reach.detail },
    });
    return;
  }
  // Kill all windows of this name (by index), not just one — a prior spawn
  // race may have left duplicates, and a single name-targeted kill can't
  // remove them (the target is ambiguous).
  killWindowsByName(window);
  if (reach.state === "present" && windowIndices(window).length > 0) {
    log.warn("poller", "kept poll FIFO: poller window survived", {
      data: { project: projectName },
    });
    return;
  }
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
  // A missing window is evidence only when tmux answers. Inside an agent
  // sandbox every probe fails as a missing window does, and the spawn could
  // not run there anyway: its lock is in the control tree, which the sandbox
  // cannot write, so trying would throw at a caller such as `garden poke`
  // before it pokes.
  if (dashboardReach().state === "unreachable") return;
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

export function killReviewWindow(projectName: string, workerName: string): void {
  const revWindow = reviewWindowName(projectName, workerName);
  if (windowExists(revWindow)) {
    killWindowSafe(revWindow);
  }
  cleanReviewFiles(projectName, workerName);
}

export function cleanReviewFiles(projectName: string, workerName: string): void {
  const resultFile = reviewResultPath(projectName, workerName);
  try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
  try { fs.unlinkSync(codexStderrSidecar(resultFile)); } catch { /* ignore */ }
  try { fs.unlinkSync(reviewPromptPath(projectName, workerName)); } catch { /* ignore */ }
}

// The ci-fix analogue of killReviewWindow, for the worker-removal tail. The
// ci-fix agent runs in its own window, so killing the review window leaves it
// running on a worker that no longer exists: its 2h timeout is enforced
// through the registry entry removal just deleted, and it can still push to
// the branch. Its pane also holds the worktree, which now defers the cleanup
// that used to reap it.
export function killCiFixWindow(projectName: string, workerName: string): void {
  const cfWindow = ciFixWindowName(projectName, workerName);
  if (windowExists(cfWindow)) killWindowSafe(cfWindow);
  cleanCiFixFiles(projectName, workerName);
}

export function cleanCiFixFiles(projectName: string, workerName: string): void {
  const resultFile = ciFixResultPath(projectName, workerName);
  try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
  // A codex-routed ci-fix agent splits stderr into a sidecar (see cleanReviewFiles).
  try { fs.unlinkSync(codexStderrSidecar(resultFile)); } catch { /* ignore */ }
  try { fs.unlinkSync(ciFixPromptPath(projectName, workerName)); } catch { /* ignore */ }
}
