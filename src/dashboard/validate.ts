// State validation and self-healing: reconciles dashboard state with tmux reality.
import fs from "node:fs";
import { SESSIONS_DIR, loadConfig } from "../config.js";
import { type DashboardState, readDashState, writeDashState, withStateLock } from "./state.js";
import { mutateRegistry, readRegistry, type WorkerRegistry } from "./registry.js";
import { paneExists, windowExists, getFirstPaneId, listHiddenWorkerWindows, killWindowSafe, tmuxSplit, setPaneTitle, setPaneLabel, tmux, disablePaneInput, renameWindow } from "./tmux.js";
import { log } from "./log.js";
import { worktreeExists, removeWorktree, pruneWorktrees } from "./git.js";
import { startProjectPoller, projectPollerRunning } from "./poller.js";
import { createGardenGrowhouseWindow, USAGE_PANE_HEIGHT } from "./create.js";
import { resolveGardenRunner } from "./runner.js";
import { gardenWindowName, workerWindowName } from "./window-names.js";
import { reviewResultPath, reviewPromptPath } from "./poller-review.js";
import { buildStatusCommand, buildUsageCommand } from "./header.js";
import { gardenRestoreFromHidden } from "./layout.js";
import { addAlert } from "./alerts.js";

/**
 * Recreate the status pane if it's missing. Reads and writes state atomically.
 * Called from the poll loop (every 30s) to catch mid-session disappearances,
 * and also from validateAndHeal on reattach.
 */
export function healStatusPane(): void {
  // Fast path: if both panes still exist there is nothing to heal, so return
  // without taking the state lock — this runs on every poll cycle and the
  // common case must stay lock-free. Only when a pane is actually missing do
  // we take the lock to recreate it and persist: the recreation (tmuxSplit)
  // then happens once under the lock so two concurrent healers can't both split
  // a pane, and the write re-reads fresh state so it can't revert a concurrent
  // hotkey navigation (activePaneId/activeWindowName) via a stale snapshot —
  // the unlocked read-modify-write this replaces did exactly that.
  const probe = readDashState();
  const statusOk = !!probe.statusPaneId && paneExists(probe.statusPaneId);
  const usageOk = !!probe.usagePaneId && paneExists(probe.usagePaneId);
  if (statusOk && usageOk) return;

  try {
    withStateLock(() => {
      const state = readDashState();
      let healed = healStatusPaneInState(state);
      healed = healUsagePaneInState(healed);
      if (healed !== state) {
        writeDashState(healed);
      }
    });
  } catch (err) {
    // The state lock is contended (e.g. an attach-time heal is holding it).
    // Skip this cycle — the next poll retries. Never throw from the poll entry
    // point (poll() calls healStatusPane without a guard).
    log.warn("validate", "healStatusPane skipped: state lock unavailable", {
      data: { error: String(err) },
    });
  }
}

function healGardenPaneInState(state: DashboardState): DashboardState {
  let healed = state;

  if (healed.gardenShellPaneId && !paneExists(healed.gardenShellPaneId)) {
    log.warn("validate", "gardenShellPaneId is stale");
    healed = { ...healed, gardenShellPaneId: null };
  }

  if (!healed.gardenShellPaneId && healed.statusPaneId && paneExists(healed.statusPaneId)) {
    try {
      const newPaneId = tmuxSplit("-v", "-t", healed.statusPaneId);
      if (newPaneId) {
        setPaneTitle(newPaneId, "growhouse");
        setPaneLabel(newPaneId, "growhouse");

        // gardenRestoreFromHidden mutates state.gardenShellPaneId in-place,
        // so work with a mutable interim object before the final spread.
        const interim = { ...healed, gardenShellPaneId: newPaneId };

        const gardenRunner = resolveGardenRunner();
        const growhouseWin = gardenWindowName("growhouse");
        if (!windowExists(growhouseWin)) {
          createGardenGrowhouseWindow(gardenRunner);
        }
        gardenRestoreFromHidden(growhouseWin, interim);

        healed = {
          ...interim,
          gardenPaneType: "growhouse" as const,
          gardenWindowName: growhouseWin,
        };
        log.info("validate", "recreated growhouse pane");
      }
    } catch (err) {
      log.warn("validate", "failed to recreate garden pane", { data: { error: String(err) } });
    }
  }

  return healed;
}

function healUsagePaneInState(state: DashboardState): DashboardState {
  let healed = state;

  if (healed.usagePaneId && !paneExists(healed.usagePaneId)) {
    log.warn("validate", "usagePaneId is stale");
    healed = { ...healed, usagePaneId: null };
  }

  if (!healed.usagePaneId && healed.statusPaneId && paneExists(healed.statusPaneId)) {
    try {
      const gardenRunner = resolveGardenRunner();
      const usageCmd = buildUsageCommand(gardenRunner);
      const usageId = tmuxSplit("-v", "-b", "-t", healed.statusPaneId, "-l", String(USAGE_PANE_HEIGHT),
        "sh", "-c", usageCmd);

      try { tmux("resize-pane", "-t", usageId, "-y", String(USAGE_PANE_HEIGHT)); } catch { /* ignore */ }
      try { tmux("clear-history", "-t", usageId); } catch { /* ignore */ }
      // Splitting shrinks status pane — flush the ghost rows pushed into scrollback by the resize.
      try { tmux("clear-history", "-t", healed.statusPaneId); } catch { /* ignore */ }
      setPaneTitle(usageId, "garden");
      setPaneLabel(usageId, "#[fg=green,bold]garden#[default] 🌱");
      disablePaneInput(usageId);

      healed = { ...healed, usagePaneId: usageId };
      log.info("validate", "recreated usage pane");
    } catch (err) {
      log.warn("validate", "failed to recreate usage pane", { data: { error: String(err) } });
    }
  }

  return healed;
}

function healStatusPaneInState(state: DashboardState): DashboardState {
  let healed = state;

  if (healed.statusPaneId && !paneExists(healed.statusPaneId)) {
    log.warn("validate", "statusPaneId is stale");
    healed = { ...healed, statusPaneId: null };
  }

  if (!healed.statusPaneId && healed.gardenShellPaneId && paneExists(healed.gardenShellPaneId)) {
    try {
      const gardenRunner = resolveGardenRunner();
      const config = loadConfig();
      const projectCount = Object.keys(config.projects).length;
      // +1 for pane-border-status top, which occupies one row of total pane height.
      const statusHeight = Math.max(4, projectCount * 2 + 2) + 1;
      const statusCmd = buildStatusCommand(gardenRunner);

      const statusId = tmuxSplit("-v", "-b", "-t", healed.gardenShellPaneId, "-l", String(statusHeight),
        "sh", "-c", statusCmd);

      try { tmux("resize-pane", "-t", statusId, "-y", String(statusHeight)); } catch { /* ignore */ }
      try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }
      setPaneTitle(statusId, "status");
      disablePaneInput(statusId);

      healed = { ...healed, statusPaneId: statusId };
      log.info("validate", "recreated status pane");
    } catch (err) {
      log.warn("validate", "failed to recreate status pane", { data: { error: String(err) } });
    }
  }

  return healed;
}

// A freshly-created worker briefly matches the ghost signature below: addWorker
// writes the "loading" registry entry BEFORE tmuxNewWindow creates its window,
// and the worktree is created later still — inside the bootstrap pane (git
// fetch + worktree add + npm install). Sweeping in that gap deletes a live
// worker and orphans it from the registry; its hooks then no-op (updateWorkerFields
// finds no entry to update), so it is never advanced past "ready" and never
// reviewed or merged. This grace keeps recently-created entries off the
// chopping block; a real ghost is still "loading" with no window/worktree once
// the grace lapses and is cleaned on a later sweep. The window only matters
// because a1ef188 moved dropGhostEntries onto every poller poke — at attach-only
// frequency the race almost never fired; at poke frequency, with many projects
// polling, a sweep routinely lands inside the creation gap.
const GHOST_CREATION_GRACE_MS = 60_000;

// Ghost entries: never-bootstrapped workers from a failed handoff or hotkey
// spawn. Identified by the combination of agentStatus === "loading" (never
// advanced to ready/idle), no tmux window, and no worktree on disk. The
// "never auto-cleanup" rule is about preserving operator work on real
// workers; these never produced any work to preserve.
//
// Mutates `registry` in place; returns true if anything was dropped. Caller
// is responsible for persisting via writeRegistry.
function dropGhostEntries(registry: WorkerRegistry, activeWindowName: string | null): boolean {
  let changed = false;
  for (const projectName of Object.keys(registry.workers)) {
    const entries = registry.workers[projectName];
    const kept = entries.filter(entry => {
      if (entry.agentStatus !== "loading") return true;
      // Within the creation grace the window/worktree may simply not exist yet
      // (see GHOST_CREATION_GRACE_MS). Trust the recent createdAt over the
      // absent window so a poll-cycle sweep can't delete a worker mid-bootstrap.
      if (entry.createdAt !== undefined && Date.now() - entry.createdAt < GHOST_CREATION_GRACE_MS) {
        return true;
      }
      if (entry.worktreePath && worktreeExists(entry.worktreePath)) return true;
      const windowName = workerWindowName(projectName, entry.name);
      if (windowExists(windowName)) return true;
      if (windowName === activeWindowName) return true;
      log.warn("validate", "removing ghost worker (loading, no worktree, no pane)", {
        worker: entry.name,
        data: { project: projectName },
      });
      return false;
    });
    if (kept.length !== entries.length) {
      registry.workers[projectName] = kept;
      changed = true;
    }
  }
  return changed;
}

/**
 * Cross-project ghost sweep, intended for repeated invocation from a poller.
 * Drops registry entries that the strict ghost rule would have removed at
 * dashboard attach time — handles ghosts that appear mid-session (e.g. a
 * fan-out handoff where some bootstraps crashed) without waiting for the
 * next dashboard restart. Returns true if any entry was dropped.
 */
export function sweepGhostEntries(): boolean {
  const activeWindowName = readDashState().activeWindowName;
  let dropped = false;
  mutateRegistry((registry) => {
    dropped = dropGhostEntries(registry, activeWindowName);
    return dropped;
  });
  return dropped;
}

/**
 * Validate dashboard state against tmux reality and heal inconsistencies.
 * Returns the healed state (may be identical if everything is consistent).
 */
export function validateAndHeal(state: DashboardState): DashboardState {
  if (windowExists("_garden-console") && !windowExists("_garden-growhouse")) {
    renameWindow("_garden-console", "_garden-growhouse");
    log.info("validate", "renamed _garden-console to _garden-growhouse");
  }
  if (windowExists("_garden-conversation") && !windowExists("_garden-history")) {
    renameWindow("_garden-conversation", "_garden-history");
    log.info("validate", "renamed _garden-conversation to _garden-history");
  }
  if (windowExists("_garden-pad") && !windowExists("_garden-diary")) {
    renameWindow("_garden-pad", "_garden-diary");
    log.info("validate", "renamed _garden-pad to _garden-diary");
  }
  if (state.gardenShellPaneId && state.gardenPaneType === "growhouse" && paneExists(state.gardenShellPaneId)) {
    setPaneTitle(state.gardenShellPaneId, "growhouse");
    setPaneLabel(state.gardenShellPaneId, "growhouse");
  }

  let healed = healStatusPaneInState(state);
  healed = healUsagePaneInState(healed);
  healed = healGardenPaneInState(healed);
  let changed = healed !== state;

  if (healed.activePaneId && !paneExists(healed.activePaneId)) {
    log.warn("validate", "activePaneId is stale, attempting recovery");
    changed = true;

    // Try to recover from the named window
    let recovered = false;
    if (healed.activeWindowName && windowExists(healed.activeWindowName)) {
      const paneId = getFirstPaneId(healed.activeWindowName);
      if (paneId) {
        healed.activePaneId = paneId;
        log.info("validate", "recovered activePaneId from window");
        recovered = true;
      }
    }

    // Fall back to any worker window for the active project
    if (!recovered && healed.activeProject) {
      const workers = listHiddenWorkerWindows(healed.activeProject);
      for (const win of workers) {
        const paneId = getFirstPaneId(win);
        if (paneId) {
          healed.activePaneId = paneId;
          healed.activePaneType = "worker";
          healed.activeWindowName = win;
          log.info("validate", "recovered activePaneId from worker window");
          recovered = true;
          break;
        }
      }
    }

    if (!recovered) {
      healed.activePaneId = null;
      healed.activePaneType = null;
      healed.activeWindowName = null;
      log.warn("validate", "could not recover activePaneId");
    }
  }

  // Validate registry against tmux windows. When a registered worker has
  // no tmux window, the pane process is gone — but the worktree on disk
  // and the branch on origin both persist. The "never auto-cleanup workers"
  // rule (per the operator's standing feedback) means we must NOT remove
  // the registry entry: a transient tmux glitch (server crash + restart)
  // would otherwise discard the worker permanently. Mark `agentStatus =
  // "exited"` (matching the pane-died hook's effect) and surface an alert
  // so the operator can either resume manually or `⌥x` to clean up.
  // One locked read-modify-write for the whole registry pass. The per-entry
  // window/worktree probes (tmux/git forks) run inside the lock, so the hold is
  // longer than a field update — but this is the attach-time / `health --fix`
  // path, not the hot poll loop, and it is strictly safer than the previous
  // unlocked read-modify-write, which silently reverted concurrent poller/hook
  // transitions when it wrote its stale snapshot. The missing-pane alerts fire
  // AFTER the lock releases (each addAlert takes the separate alerts lock, which
  // has its own deadline) — keeping that nested lock acquisition off the
  // registry-lock hold, the same way addAlert keeps its own side effects out.
  const markedExited: Array<{ project: string; worker: string }> = [];
  mutateRegistry((registry) => {
    let registryChanged = false;

    // Drop ghost entries FIRST. Must run before the "mark exited" pass —
    // that pass would otherwise rewrite agentStatus from "loading" to
    // "exited" and the ghost would slip through as a preserved exited worker.
    if (dropGhostEntries(registry, healed.activeWindowName)) {
      registryChanged = true;
    }

    for (const [projectName, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        const windowName = workerWindowName(projectName, entry.name);
        const exists = windowExists(windowName) || windowName === healed.activeWindowName;
        if (exists) continue;
        if (entry.agentStatus === "exited") continue; // already marked
        log.warn("validate", "worker window missing, marking exited (entry preserved)", {
          worker: entry.name,
          data: { project: projectName, prState: entry.prState },
        });
        entry.agentStatus = "exited";
        registryChanged = true;
        markedExited.push({ project: projectName, worker: entry.name });
      }
    }

    // Validate worktrees for registry entries
    for (const [projectName, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        if (!entry.worktreePath) continue;
        if (!worktreeExists(entry.worktreePath)) {
          log.warn("validate", "worktree missing for worker", {
            worker: entry.name,
            data: { project: projectName },
          });
          entry.worktreePath = undefined;
          registryChanged = true;
        }
      }
    }

    return registryChanged;
  });

  // Surface the "worker has no tmux pane" alerts outside the registry lock (see
  // above). The dedupKey is stable per (project, worker), so firing after the
  // lock doesn't change dedup behavior.
  for (const { project, worker } of markedExited) {
    addAlert({
      level: "warn",
      source: "validate",
      project,
      worker,
      message:
        `Worker '${worker}' has no tmux pane. The worktree on disk is preserved — ` +
        `restart the dashboard ('garden dashboard exit && garden dashboard') to recreate ` +
        `the pane from the registry, or kill the worker (⌥x) to clean up. ` +
        `'garden bounce' won't work without a live pane.`,
      // Stable key so a single missing pane doesn't spam the badge across
      // every reattach within the dedup window.
      dedupKey: `validate-exited:${project}:${worker}`,
    });
  }

  // Clean stale lastActiveWorker references pointing to dead windows
  for (const [proj, winName] of Object.entries(healed.lastActiveWorker ?? {})) {
    if (!windowExists(winName) && winName !== healed.activeWindowName) {
      delete healed.lastActiveWorker[proj];
      changed = true;
      log.info("validate", "cleared stale lastActiveWorker", { data: { project: proj, window: winName } });
    }
  }

  // Prune orphaned git worktrees
  try {
    const config = loadConfig();
    for (const project of Object.values(config.projects)) {
      pruneWorktrees(project.path);
    }
  } catch { /* best effort */ }

  // Clean stale context files
  cleanContextFiles();

  // Restart per-project pollers if not running. Read a fresh snapshot for the
  // read-only consumers below (poller restart, orphaned-window cleanup) so they
  // observe the post-heal registry rather than a pre-mutation copy.
  const registry = readRegistry();
  const gardenRunner = resolveGardenRunner();
  for (const projectName of Object.keys(registry.workers)) {
    if (registry.workers[projectName].length > 0 && !projectPollerRunning(projectName)) {
      log.info("validate", "project poller not running, restarting", { data: { project: projectName } });
      startProjectPoller(projectName, gardenRunner);
    }
  }

  // Clean orphaned review windows
  cleanOrphanedReviewWindows(registry);

  if (changed) {
    log.info("validate", "state healed");
  }

  return healed;
}

export function cleanContextFiles(): void {
  try {
    const config = loadConfig();
    const projectNames = new Set(Object.keys(config.projects));
    // A reviewer or resolver writes its verdict into the review-result file and
    // reads its prompt from the review-prompt file. If cleanContextFiles runs
    // during a live review (this fires on every dashboard attach), deleting
    // those files leaves the verdict unreadable and spuriously fails the review.
    // Protect the files of any worker whose review/resolve window is still up.
    const registry = readRegistry();
    const protectedFiles = new Set<string>();
    for (const [projectName, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        if (entry.reviewWindowName && windowExists(entry.reviewWindowName)) {
          protectedFiles.add(reviewResultPath(projectName, entry.name).split("/").pop()!);
          protectedFiles.add(reviewPromptPath(projectName, entry.name).split("/").pop()!);
        }
      }
    }
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      // Clean stale context files
      if (file.startsWith("dashboard-") && file.endsWith(".context")) {
        const projectName = file.replace("dashboard-", "").replace(".context", "");
        if (!projectNames.has(projectName)) {
          fs.unlinkSync(`${SESSIONS_DIR}/${file}`);
          log.info("validate", "removed stale context file", { data: { file } });
        }
        continue;
      }
      // Clean stale review result/prompt files — but never one belonging to an
      // in-flight review/resolve (its window is still alive).
      if (file.endsWith("-review-result.txt") || file.endsWith("-review-prompt.txt")) {
        if (protectedFiles.has(file)) continue;
        fs.unlinkSync(`${SESSIONS_DIR}/${file}`);
        log.info("validate", "removed stale review file", { data: { file } });
      }
    }
  } catch { /* sessions dir might not exist */ }
}

export function cleanOrphanedReviewWindows(registry: WorkerRegistry): void {
  // Decide which review windows are dead OUTSIDE the registry lock: windowExists
  // is a tmux fork, and holding the lock across a per-entry fork would stall
  // concurrent hook writes. Record the exact window name we observed dead.
  const stale: { project: string; worker: string; windowName: string }[] = [];
  for (const [projectName, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.reviewWindowName && !windowExists(entry.reviewWindowName)) {
        stale.push({ project: projectName, worker: entry.name, windowName: entry.reviewWindowName });
      }
    }
  }
  if (stale.length === 0) return;

  // Apply as a compare-and-clear against FRESH state. The snapshot above may be
  // seconds old (validate probes panes/worktrees between reading it and here),
  // and a new review can launch in that gap and set a NEW reviewWindowName.
  // Clear only if the current value still equals the dead window we observed —
  // a blind clear would wipe the live review's fresh window name, after which
  // handleReviewing finds no window, re-runs the review, and kills the one still
  // running (wasted paid work, and two aligned races park the worker failing).
  mutateRegistry((reg) => {
    let changed = false;
    for (const { project, worker, windowName } of stale) {
      const entry = reg.workers[project]?.find((e) => e.name === worker);
      if (entry && entry.reviewWindowName === windowName) {
        entry.reviewWindowName = undefined;
        changed = true;
        log.info("validate", "cleared stale reviewWindowName", {
          worker,
          data: { project },
        });
      }
    }
    return changed;
  });
}
