// Merge queue + finalization: handleMergePending, finalizeMerge, the
// post-merge auto-continue gate, postMerge command execution, sibling
// notification.
//
// The serial merge gate (only the earliest mergePendingAt worker proceeds)
// lives here. When a rebase conflict appears, control transfers to the
// resolver lifecycle in poller-resolve.ts.
import { execSync, execFileSync, spawn } from "node:child_process";
import {
  tryGetProject, getAutoContinueConfig, setAutoContinueConfig,
} from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { addAlert } from "./alerts.js";
import { dispatchDelayedAutoContinue, isDoneSet, setDoneSentinel } from "./continue.js";
import { dispatchDelayedGrowContinue } from "./grow-continue.js";
import { dispatchDelayedTrellisContinue } from "./trellis-continue.js";
import { resolveGardenRunner } from "./runner.js";
import {
  abortRebase, cleanWorktree, deleteRemoteBranch, ensureNoRebaseInProgress,
  fastForwardBase, forcePushBranch, getBranchHeadSha, getChangedFiles,
  getChangedFilesBetween, getCommitSummary, mergeToBase, rebaseBranch,
  syncWorktreeToRemote,
} from "./git.js";
import { refreshDashboard, setupStatusBar } from "./header.js";
import { setupKeybindings } from "./hotkeys.js";
import { log } from "./log.js";
import {
  findWorkerByName, getWorkers, updateWorkerFields,
  type PrState, type WorkerEntry,
} from "./registry.js";
import { tmux, getFirstPaneId, windowExists, pasteAndSubmit } from "./tmux.js";
import { readUsageSnapshot } from "./usage.js";
import { workerWindowName } from "./window-names.js";
import { scheduleDelayedPoke } from "./poller-fifo.js";
import { transitionState } from "./poller-state.js";
import { killReviewWindow } from "./poller-review.js";
import { launchResolver } from "./poller-resolve.js";

const AUTO_CONTINUE_DEBOUNCE_MS = 10_000;

export function handleMergePending(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // Serial merge gate: only the earliest merge-pending worker proceeds
  const projectWorkers = getWorkers(projectName);
  const olderPending = projectWorkers.some(w =>
    w.name !== entry.name &&
    w.prState === "merge-pending" &&
    (w.mergePendingAt ?? "") < (entry.mergePendingAt ?? ""),
  );
  if (olderPending) return false;

  const wtPath = entry.worktreePath ?? projectPath;

  // Fetch latest base branch
  try {
    execFileSync("git", ["fetch", "origin", baseBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch (err) {
    log.debug("poller", "fetch before merge failed", { worker: entry.name, data: { error: String(err) } });
  }

  // Clear any leftover rebase state (e.g., from a prior resolver that crashed).
  // Without this, the next `git rebase` can surface confusing errors that the
  // poller would misinterpret.
  ensureNoRebaseInProgress(wtPath);

  // Clean tooling artifacts (Claude settings, hook dirs) left by the reviewer.
  // By this point all meaningful changes are committed — anything left is noise.
  cleanWorktree(wtPath, { project: projectName, worker: entry.name });

  // Rebase onto current base branch
  const rebaseResult = rebaseBranch(wtPath, baseBranch);
  if (rebaseResult.kind === "conflict") {
    abortRebase(wtPath);
    // Direct call into poller-resolve, intentionally — not a workflow
    // dispatch. handleResolving's contract assumes the resolver is already
    // in-flight (reviewWindowName + reviewStartedAt set on the entry); only
    // launchResolver populates those. Routing through workflow.stateHandlers
    // ["resolving"] would either need a fresh-entry branch in handleResolving
    // (more state machine) or a pre-populate step here (more coupling). The
    // right extension point when a second workflow needs different conflict
    // behavior is `WorkflowDefinition.onMergeConflict?: (ctx) => boolean` —
    // see WORKFLOWS.md "Limitations and future extension points".
    return launchResolver(projectName, projectPath, baseBranch, entry);
  }
  if (rebaseResult.kind === "error") {
    abortRebase(wtPath);
    const detail = rebaseResult.error.slice(0, 300);
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Rebase failed (not a conflict) — manual intervention needed: ${detail}`,
    });
    const headSha = getBranchHeadSha(wtPath);
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingReason: "code",
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      mergePendingAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  // Force-push rebased branch
  const branchName = entry.branchName ?? entry.name;
  try {
    forcePushBranch(wtPath, branchName);
  } catch (err) {
    log.error("poller", "force-push failed in merge queue", {
      worker: entry.name,
      data: { error: String(err) },
    });
    transitionState(projectName, entry.name, "working", {
      mergePendingAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  // Merge to base branch
  finalizeMerge(projectName, projectPath, baseBranch, entry);
  return true;
}

function finalizeMerge(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): void {
  const branchName = entry.branchName ?? entry.name;

  // Snapshot changed files BEFORE merge — after mergeToBase pushes, the
  // remote tracking ref advances to include our commits and the diff is empty.
  const preMergeChangedFiles = entry.worktreePath
    ? getChangedFiles(entry.worktreePath, baseBranch)
    : [];

  try {
    mergeToBase(projectPath, branchName, baseBranch, { project: projectName, worker: entry.name });
  } catch (err) {
    log.error("poller", "merge failed", {
      worker: entry.name,
      data: { error: String(err) },
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Merge failed for worker ${entry.name}: ${String(err).slice(0, 200)}`,
    });
    // Set pendingReviewAt so the worker gets re-reviewed instead of being
    // stuck in "working" with no trigger to advance.
    transitionState(projectName, entry.name, "working", {
      pendingReviewAt: Date.now(),
      mergePendingAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 5_000);
    return;
  }

  log.info("poller", "merged to base branch", { worker: entry.name, data: { baseBranch } });

  const sentinelPresent = isDoneSet(entry.worktreePath);
  const sync = syncWorktreeAfterMerge(projectName, branchName, entry, sentinelPresent);
  notifyPostMerge(projectName, projectPath, baseBranch, entry, preMergeChangedFiles);
  transitionToTerminal(projectName, branchName, entry, sentinelPresent, sync);
  refreshDashboard();
}

// Phase 1 of finalizeMerge: bring the worker's worktree forward to the
// merged tip so the worker resumes on the post-review code, not its own
// pre-review HEAD. Runs BEFORE deleteRemoteBranch — worktrees share refs
// with the main repo, so once origin/<branch> is gone both
// `git fetch origin <branch>` and `git reset --hard origin/<branch>` fail.
// When .garden-done is set, the worker self-declared done and auto-continue
// won't fire; skip the sync entirely (the sentinel itself shows as untracked
// and would always trip the dirty check).
//
// Returns the file list to surface in the auto-continue prompt and a flag
// indicating whether the sync failed (operator-visible alert was already
// fired by this helper).
interface SyncOutcome {
  changedFiles: string[];
  syncFailed: boolean;
}
function syncWorktreeAfterMerge(
  projectName: string,
  branchName: string,
  entry: WorkerEntry,
  sentinelPresent: boolean,
): SyncOutcome {
  if (!entry.worktreePath || sentinelPresent) {
    return { changedFiles: [], syncFailed: false };
  }
  const fromSha = entry.preReviewSha;
  const sync = syncWorktreeToRemote(entry.worktreePath, branchName);
  if (sync.ok) {
    log.info("poller", "synced worktree to merged tip", {
      worker: entry.name,
      data: { branch: branchName },
    });
    const toSha = getBranchHeadSha(entry.worktreePath);
    if (fromSha && toSha && fromSha !== toSha) {
      return {
        changedFiles: getChangedFilesBetween(entry.worktreePath, fromSha, toSha),
        syncFailed: false,
      };
    }
    return { changedFiles: [], syncFailed: false };
  }
  // Sync failed — log + alert at the severity matching the cause. "dirty"
  // is operator-recoverable (commit/stash); other reasons are git-level
  // failures and warrant the higher level.
  const logData = { branch: branchName, reason: sync.reason, error: sync.error };
  const alertMessage = sync.reason === "dirty"
    ? `Could not sync worker ${entry.name} after merge: worktree has uncommitted changes. Worker resumes on stale HEAD until cleaned up.`
    : `Post-merge sync failed for worker ${entry.name} (${sync.reason}): ${(sync.error ?? "").slice(0, 200)}`;
  if (sync.reason === "dirty") {
    log.warn("poller", "post-merge worktree sync failed", { worker: entry.name, data: logData });
    addAlert({ level: "warn", source: "poller", project: projectName, worker: entry.name, message: alertMessage });
  } else {
    log.error("poller", "post-merge worktree sync failed", { worker: entry.name, data: logData });
    addAlert({ level: "error", source: "poller", project: projectName, worker: entry.name, message: alertMessage });
  }
  return { changedFiles: [], syncFailed: true };
}

// Phase 2 of finalizeMerge: side-effects against the project as a whole —
// delete the remote branch, fast-forward the local checkout (so postMerge
// runs against the merged code), notify any siblings whose branches
// overlap, run postMerge if configured, alert on stuck checkout.
function notifyPostMerge(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  preMergeChangedFiles: string[],
): void {
  const branchName = entry.branchName ?? entry.name;
  deleteRemoteBranch(projectPath, branchName, { project: projectName, worker: entry.name });

  // mergeToBase only pushes to the remote via refspec — it never touches
  // the local checkout. Update the main checkout so postMerge (e.g.
  // `npm run build`) runs against the newly merged code, not stale files.
  const advanced = fastForwardBase(projectPath, baseBranch, { project: projectName, worker: entry.name });

  notifySiblingWorkers(projectName, baseBranch, entry, preMergeChangedFiles);

  if (advanced) {
    runPostMerge(projectName, projectPath);
    return;
  }
  // Always alert on a stuck checkout: drift rots manual workflow regardless
  // of whether postMerge was configured.
  const postMergeNote = tryGetProject(projectName)?.postMerge
    ? " postMerge was skipped."
    : "";
  log.error("poller", "local base checkout did not fast-forward after merge", {
    worker: entry.name,
    data: { projectPath, baseBranch },
  });
  addAlert({
    level: "error",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message: `Local ${baseBranch} checkout at ${projectPath} did not fast-forward after merge (likely a dirty working tree or divergent branch).${postMergeNote} Clean the checkout so it stays current with merged work.`,
  });
}

// Phase 3 of finalizeMerge: write the terminal prState (`done` when the
// worker self-declared finished via .garden-done, else `merged`) plus the
// per-merge field reset, handle the worker-already-working race, and
// dispatch the post-merge auto-continue prompt.
function transitionToTerminal(
  projectName: string,
  branchName: string,
  entry: WorkerEntry,
  sentinelPresent: boolean,
  sync: SyncOutcome,
): void {
  // Per STATUS.md invariant 4: pick `done` when the worker wrote .garden-done
  // before its final push (skip the transient `merged` beat and go straight
  // to the operator-actionable cleanup signal). Otherwise set `merged` —
  // auto-continue clears it on the next prompt.
  const terminalState: PrState = sentinelPresent ? "done" : "merged";
  transitionState(projectName, entry.name, terminalState, {
    mergedAt: new Date().toISOString(),
    failCount: 0,
    mergePendingAt: undefined,
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    lastReviewBody: undefined,
    resolveAttempts: 0,
    preResolveSha: undefined,
    lastResolveBody: undefined,
    preReviewSha: undefined,
    pendingContinueChangedFiles: sync.changedFiles.length ? sync.changedFiles : undefined,
    pendingContinueSyncFailed: sync.syncFailed ? true : undefined,
  });

  // STATUS.md invariant 4 race: a prompt hook that landed mid-merge can't
  // clear an active pipeline prState (which `merged`/`done` is at the moment
  // of write). If the worker is already working again, clear the stale
  // terminal state immediately so the renderer doesn't show a phantom merge.
  const fresh = findWorkerByName(projectName, entry.name);
  if (fresh?.claudeStatus === "working") {
    log.info("poller", "worker already active after merge, clearing terminal state", {
      worker: entry.name,
      data: { clearedFrom: terminalState },
    });
    transitionState(projectName, entry.name, "working", {
      mergedAt: undefined,
      lastSeenSha: undefined,
    });
  }

  maybeAutoContinue(projectName, branchName, fresh ?? entry);
}

// After a clean merge, send the worker a "please proceed" prompt so multi-phase
// work continues without manual intervention. The worker opts out by writing
// the .garden-done sentinel (see continue.ts donePath); pause/resume commands toggle
// the same file. Skips when the worker is already mid-turn or when the same
// merge event would re-fire within AUTO_CONTINUE_DEBOUNCE_MS.
function maybeAutoContinue(
  projectName: string,
  branchName: string,
  entry: WorkerEntry,
): void {
  const perWorkerReason = autoContinueSkipReason(entry);
  if (perWorkerReason) {
    log.debug("poller", "auto-continue skipped", {
      worker: entry.name,
      data: { project: projectName, reason: perWorkerReason },
    });
    return;
  }
  const gateReason = autoContinueGateReason();
  if (gateReason) {
    log.info("poller", "auto-continue blocked by global gate", {
      worker: entry.name,
      data: { project: projectName, reason: gateReason },
    });
    return;
  }
  // Grow budget check: if iter K just completed and K >= max, the loop is
  // done — budget exhaustion lands on `done`, not `failing`, because grow
  // has no convergence target to fail against. Write the sentinel so any
  // replayed merge event also recognizes done, transition merged → done,
  // skip the respawn dispatch.
  if (entry.workflow === "grow") {
    const iter = entry.grow?.iteration ?? 0;
    const max = entry.grow?.maxIterations ?? 5;
    if (iter >= max) {
      setDoneSentinel(entry.worktreePath);
      transitionState(projectName, entry.name, "done", {});
      log.info("poller", "grow loop completed at iteration budget", {
        worker: entry.name,
        data: { project: projectName, iterations: iter, max },
      });
      return;
    }
  }
  updateWorkerFields(projectName, entry.name, { lastAutoContinueAt: Date.now() });
  log.info("poller", "auto-continued worker after merge", {
    worker: entry.name,
    data: {
      project: projectName,
      branch: branchName,
      workflow: entry.workflow ?? "default",
    },
  });
  // Trellis and grow loops reset to a fresh Claude session every iteration
  // (per-iteration context reset). Default workers send into the live session.
  if (entry.workflow === "trellis") {
    dispatchDelayedTrellisContinue(resolveGardenRunner(), projectName, entry.name);
  } else if (entry.workflow === "grow") {
    dispatchDelayedGrowContinue(resolveGardenRunner(), projectName, entry.name);
  } else {
    dispatchDelayedAutoContinue(resolveGardenRunner(), projectName, entry.name);
  }
}

function autoContinueSkipReason(entry: WorkerEntry): string | null {
  if (isDoneSet(entry.worktreePath)) return "done-sentinel";
  if (entry.claudeStatus === "working" || entry.claudeStatus === "asking") {
    return `claude-${entry.claudeStatus}`;
  }
  if (entry.lastAutoContinueAt
      && Date.now() - entry.lastAutoContinueAt < AUTO_CONTINUE_DEBOUNCE_MS) {
    return "idempotency-window";
  }
  return null;
}

// Global auto-continue gate. Mutates config when it auto-resumes after a
// usage-window reset or auto-disables after a threshold cross. Returns null
// when auto-continue is allowed to proceed; otherwise a short reason tag.
export function autoContinueGateReason(): string | null {
  let cfg = getAutoContinueConfig();

  if (!cfg.enabled && cfg.pausedUntil && cfg.resumeAfterReset) {
    const resetMs = Date.parse(cfg.pausedUntil);
    if (Number.isFinite(resetMs) && Date.now() >= resetMs) {
      cfg = setAutoContinueConfig({
        enabled: true,
        pausedUntil: undefined,
        pausedReason: undefined,
      });
      log.info("poller", "auto-continue re-enabled after usage window reset", {});
    }
  }

  if (!cfg.enabled) {
    return cfg.pausedUntil ? "usage-paused" : "globally-disabled";
  }

  const tripped = checkUsageThreshold(cfg.usageThreshold);
  if (tripped) {
    setAutoContinueConfig({
      enabled: false,
      pausedUntil: tripped.pausedUntil,
      pausedReason: tripped.reason,
    });
    addAlert({
      level: "warn",
      source: "usage",
      project: "garden",
      message: `Auto-continue disabled: ${tripped.reason}. Run 'garden auto on' to re-enable.`,
    });
    log.warn("poller", "auto-continue auto-disabled by usage threshold", {
      data: { reason: tripped.reason, pausedUntil: tripped.pausedUntil },
    });
    return "usage-threshold";
  }

  return null;
}

// Sonnet is intentionally excluded — the operator runs Opus, sonnet quota is
// unused. When multiple meters trip, pause until the latest reset so we don't
// re-enable into a still-tripped meter.
export function checkUsageThreshold(threshold: number): { pausedUntil: string; reason: string } | null {
  const snap = readUsageSnapshot();
  if (!snap?.data) return null;
  const candidates: Array<{ label: string; pct: number; resetsAt: string }> = [];
  if (snap.data.fiveHour) candidates.push({ label: "5h", ...snap.data.fiveHour });
  if (snap.data.weekly)   candidates.push({ label: "week", ...snap.data.weekly });
  const tripped = candidates.filter(c => c.pct >= threshold);
  if (tripped.length === 0) return null;
  const latest = tripped.reduce((a, b) =>
    Date.parse(a.resetsAt) > Date.parse(b.resetsAt) ? a : b);
  const reason = tripped.map(c => `${c.label} at ${Math.round(c.pct)}%`).join(", ");
  return { pausedUntil: latest.resetsAt, reason };
}

function runPostMerge(projectName: string, projectPath: string): void {
  const project = tryGetProject(projectName);
  if (!project?.postMerge) return;

  const commit = getBranchHeadSha(projectPath)?.slice(0, 7) ?? "unknown";

  try {
    execSync(project.postMerge, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (projectName === "garden") {
      log.info("poller", "garden rebuilt", { data: { commit } });
    } else {
      log.info("poller", "postMerge completed", { data: { commit } });
    }
    // Detached handoff via the rebuilt binary — this process still has pre-rebuild code in memory
    if (projectName === "garden") {
      try {
        const gr = resolveGardenRunner();
        setupKeybindings(gr);
        setupStatusBar(gr);
        spawn("sh", ["-c", `${gr} dashboard _post-rebuild-refresh 2>/dev/null`], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch { /* dashboard may not be running */ }
    }
  } catch (err) {
    const message = projectName === "garden"
      ? `Garden rebuild failed at commit ${commit}: ${String(err).slice(0, 200)}`
      : `postMerge failed at commit ${commit}: ${String(err).slice(0, 200)}`;
    log.error("poller", "postMerge failed", {
      data: { commit, error: String(err) },
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      message,
      // Stable key — message embeds the commit SHA, which would defeat the
      // default truncation if every retry landed on a new commit. With this
      // key, repeating postMerge failures collapse to one alert per project
      // per dedup window.
      dedupKey: `postMerge-failed:${projectName}`,
    });
  }
}

function notifySiblingWorkers(
  projectName: string,
  baseBranch: string,
  mergedEntry: WorkerEntry,
  mergedFiles: string[],
): void {
  if (!mergedEntry.worktreePath) return;
  if (mergedFiles.length === 0) return;

  const commitSummary = getCommitSummary(mergedEntry.worktreePath, baseBranch);
  // pushed is no longer a state in the new model — workers go straight from
  // working to reviewing via the Stop hook poke. The siblings to notify are
  // those whose code is still in flight.
  const siblings = getWorkers(projectName).filter(
    w => w.name !== mergedEntry.name &&
      (!w.prState || w.prState === "working" || w.prState === "failing"),
  );

  const mergedSet = new Set(mergedFiles);

  for (const sibling of siblings) {
    if (!sibling.worktreePath) continue;
    const siblingFiles = getChangedFiles(sibling.worktreePath, baseBranch);
    const overlap = siblingFiles.filter(f => mergedSet.has(f));
    if (overlap.length === 0) continue;

    const title = commitSummary?.split("\n")[0] ?? `worker ${mergedEntry.name}`;
    const fileList = overlap.join(", ");
    const message = [
      `[garden] Worker \`${mergedEntry.name}\` just merged into ${baseBranch}: ${title}`,
      `It changed files that overlap with your branch: ${fileList}`,
      `Rebase onto ${baseBranch}, review how these changes interact with your work, and make sure you are not reverting their fix. Push when ready.`,
    ].join("\n");

    const windowName = workerWindowName(projectName, sibling.name);
    if (!windowExists(windowName)) continue;

    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
    if (!paneId) continue;

    // Liveness from the registry (claudeStatus is hook-driven). A sibling
    // marked exited is dead — skip.
    if (sibling.claudeStatus === "exited") {
      log.info("poller", "skipping dead sibling", {
        worker: sibling.name,
        data: { mergedWorker: mergedEntry.name },
      });
      continue;
    }

    pasteAndSubmit(paneId, message);
    log.info("poller", "notified sibling of merge overlap", {
      worker: sibling.name,
      data: { mergedWorker: mergedEntry.name, overlapFiles: overlap },
    });
  }
}
