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
  anyAnthropicMeteredProject,
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
  getChangedFilesBetween, getCommitSummary, isAncestor, mergeToBase, rebaseBranch,
  syncWorktreeToRemote,
} from "./git.js";
import { refreshDashboard, setupStatusBar } from "./header.js";
import { setupKeybindings } from "./hotkeys.js";
import { log } from "./log.js";
import {
  findWorkerByName, getWorkers, updateWorkerFields,
  type PrState, type WorkerEntry,
} from "./registry.js";
import { tmux, getFirstPaneId, windowExists } from "./tmux.js";
import { getHarnessCore } from "./harness/core.js";
import { readUsageSnapshot, snapshotMeters } from "./usage.js";
import { workerWindowName } from "./window-names.js";
import { scheduleDelayedPoke, isWorkerClaudeWorking } from "./poller-fifo.js";
import { transitionState } from "./poller-state.js";
import { maybeDispatchHolisticReview } from "./poller-holistic-review.js";
import { killReviewWindow } from "./poller-review.js";
import { launchResolver } from "./poller-resolve.js";
import { launchCiFix } from "./poller-ci-fix.js";
import { checkCiStatus, getGitHubRepoSlug, type CiStatus } from "./poller-ci.js";

const AUTO_CONTINUE_DEBOUNCE_MS = 10_000;
// Last fast-forward outcome per `${project}:${base}`, so the post-merge alert
// fires only when the local base checkout *enters* an un-advanceable state (or
// switches failure modes), not on every subsequent merge while it stays broken.
// In-memory, per poller process: a poller restart re-alerts once, which is
// acceptable. Keyed by project:base (not worker) because a stuck checkout
// affects every worker's merge — the operator wants one alert, not one each.
const lastFfState = new Map<string, string>();

// Test seam: clear the entry-tracking map so each test starts from a clean
// "never seen" state and its single poll() counts as an entry.
export function __resetFfStateForTest(): void {
  lastFfState.clear();
  projectHasCi.clear();
  ciNoRunsSince.clear();
  ciRecheckArmedUntil.clear();
}
// Stranded threshold for the merged-state sweep. Must outlast the +6s/+16s
// delivery legs of a merge-time dispatch so the sweep never races an
// in-flight prompt with a duplicate paste.
const SWEEP_STRANDED_MS = 60_000;
// Re-check CI on a pending check-run after this long. The check-runs API
// is cheap and gh's rate limit is generous; a 60s cadence is fast enough
// that the merge doesn't feel stuck without burning quota on a tight loop.
const CI_PENDING_RECHECK_MS = 60_000;
// Per-project (in-memory, per poller) knowledge that the project HAS GitHub
// Actions — set the first time any check-run is observed. Lets the CI gate tell
// "genuinely no CI" (never saw a check-run → pass empty check-runs through at
// once) from "checks not yet materialized" (this project has CI, so zero
// check-runs on a freshly force-pushed SHA — a reviewer `fixed` or ci-fix commit
// the poller pokes with delay 0 — means they are still spinning up, so defer,
// otherwise the exact commit CI most needs to vet merges un-gated). A poller
// restart re-learns it on the first check-run.
const projectHasCi = new Map<string, boolean>();
// Epoch ms when the gate first saw zero check-runs on a CI-having project,
// keyed by `${project}:${sha}`, so the grace-window defer is bounded.
const ciNoRunsSince = new Map<string, number>();
// Check-runs materialize within ~30s of a push; 3 min is a safe ceiling past
// which we conclude a CI project's SHA genuinely has none and stop deferring.
const CI_NO_RUNS_GRACE_MS = 3 * 60_000;
// Per-project epoch ms until which a 60s recheck poke is already armed, so a
// burst of external pokes during a pending / grace stall doesn't stack a fresh
// self-perpetuating sleeper on each one (they would otherwise accumulate).
const ciRecheckArmedUntil = new Map<string, number>();

// Arm the single 60s CI recheck poke for a project, deduped: if one is already
// scheduled (armed time still in the future) do nothing, so repeated gate
// defers across a stall don't stack sleepers.
function armCiRecheck(projectName: string): void {
  const now = Date.now();
  if ((ciRecheckArmedUntil.get(projectName) ?? 0) > now) return;
  ciRecheckArmedUntil.set(projectName, now + CI_PENDING_RECHECK_MS);
  scheduleDelayedPoke(projectName, CI_PENDING_RECHECK_MS);
}
// Failure budget before the worker is parked in `failing` instead of
// re-reviewing again. Compared against the shared `failCount` (all failure
// kinds since the last successful merge, which resets it), so in the common
// case of a pure merge-failure loop this is the merge-attempt count. A merge
// failure re-arms a full review each cycle, so an un-bounded loop (a diverged
// base, branch protection) would burn one Opus review every few seconds
// forever. A transient cause clears within a couple of retries; past this we
// stop and surface it for the operator.
const MAX_MERGE_RETRIES = 3;

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

  // Fetch latest base branch (before the CI gate and the resume check, both
  // of which read origin/<base>).
  try {
    execFileSync("git", ["fetch", "origin", baseBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch (err) {
    log.debug("poller", "fetch before merge failed", { worker: entry.name, data: { project: projectName, error: String(err) } });
  }

  // Resume an interrupted merge. mergeToBase fast-forward-pushes the worker's
  // HEAD onto origin/<base>, so once the base push has happened the worktree
  // HEAD is contained in origin/<base>. If we observe that on entry, a prior
  // finalization pushed the merge but was interrupted before the terminal-state
  // transition — the poller can be torn down mid-finalize when a garden binary
  // rebuild restarts every project's poller (see _post-rebuild-refresh). Naively
  // re-running rebase + force-push here hits a force-with-lease "stale info"
  // rejection against the now-deleted/diverged remote branch, and the force-push
  // catch below now re-arms a full re-review of an already-merged worker and
  // fires a spurious push-failed alert (it no longer strands, but the wasted
  // cycle also masks a trellis ALIGNED convergence). Detect it and resume
  // finalization idempotently instead.
  const headSha = getBranchHeadSha(wtPath);
  if (headSha && isAncestor(wtPath, headSha, `origin/${baseBranch}`)) {
    resumeInterruptedMerge(projectName, projectPath, baseBranch, entry);
    return true;
  }

  // Do NOT touch the shared worktree while the worker's Claude is mid-turn.
  // cleanWorktree (`git checkout -- .`) and the rebase below rewrite tracked
  // files and HEAD; if the operator prompted this merge-pending worker and it is
  // editing files not yet committed, git rebase would refuse on the dirty tree
  // but cleanWorktree turns that refusal into a silent wipe of the unstaged
  // edits (there is no reflog for unstaged changes). launchResolver guards the
  // identical shared-worktree hazard. Defer past the resume check (an
  // already-pushed merge is safe to finalize regardless): the worker's Stop hook
  // re-pokes on turn end, and the watchdog backstops a lost poke since
  // merge-pending is a watched state.
  if (isWorkerClaudeWorking(projectName, entry.name)) {
    log.debug("poller", "merge deferred: worker Claude is active in the shared worktree", {
      worker: entry.name,
      data: { project: projectName },
    });
    return false;
  }

  // CI gate: defense-in-depth against merging a branch with red GitHub
  // Actions. Runs BEFORE the rebase/force-push so we read CI for the SHA
  // the worker actually published; the post-merge SHA on base is the same
  // commits in their rebased form, and the workers we're guarding push
  // frequently enough during their turn that CI is usually already
  // settled by the time the reviewer signs off. See poller-ci.ts.
  if (!gateCiStatus(projectName, projectPath, baseBranch, entry)) return false;

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
      data: { project: projectName, error: String(err) },
    });
    // Re-arm rather than strand the worker in an unwatched `working` state (see
    // tryForcePushAfterReview): a transient failure self-heals via a fresh
    // review, a persistent one is surfaced by the deduped alert, and the 30s
    // poke floor keeps it from tight-looping.
    addAlert({
      level: "warn",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Force-push in the merge queue failed for '${entry.name}'; re-queuing a review to retry. ${String(err).slice(0, 200)}`,
      dedupKey: `push-failed:${projectName}:${entry.name}`,
    });
    transitionState(projectName, entry.name, "working", {
      pendingReviewAt: Date.now(),
      mergePendingAt: undefined,
      // Fresh cycle: reset the resolver budget and stale resolve state, matching
      // resetToWorkingOnWorkerPush / finalizeMerge. Without this, a resolver-
      // verified branch that reaches this force-push (resolveAttempts already at
      // budget) would, after re-review, hit escalateResolveBudget on the next
      // genuine conflict without ever launching a resolver.
      resolveAttempts: 0,
      preResolveSha: undefined,
      lastResolveBody: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 30_000);
    return true;
  }

  // Merge to base branch
  finalizeMerge(projectName, projectPath, baseBranch, entry);
  return true;
}

// CI gate. Returns true when the caller should proceed with the merge,
// false when the worker should stay parked in merge-pending. On a
// confirmed CI failure this transitions the worker to `failing` and
// alerts the operator; the caller still receives false.
//
// Behaves as a no-op for projects with requireCiSuccess: false, projects
// whose origin isn't a github.com remote, environments without `gh`, and
// projects with zero check-runs on the SHA that have never been observed to
// run CI (nothing to gate against). On a project already known to run CI,
// zero check-runs means they haven't materialized yet, so the merge defers
// within a bounded grace window (CI_NO_RUNS_GRACE_MS) before passing through.
// The handoff explicitly called out the `gh`/non-github cases: blocking
// workers from merging just because the operator's box doesn't have `gh`
// installed would be a worse regression than the bug this fixes.
function gateCiStatus(
  projectName: string,
  projectPath: string,
  _baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const project = tryGetProject(projectName);
  // Default-on: requireCiSuccess === false is the explicit opt-out.
  if (project?.requireCiSuccess === false) return true;

  const wtPath = entry.worktreePath ?? projectPath;
  const sha = getBranchHeadSha(wtPath);
  if (!sha) {
    log.warn("poller", "ci gate: no HEAD sha, skipping", { worker: entry.name, data: { project: projectName } });
    return true;
  }

  const slug = getGitHubRepoSlug(projectPath);
  if (!slug) {
    log.debug("poller", "ci gate: origin is not github, skipping", {
      worker: entry.name,
      data: { project: projectName },
    });
    return true;
  }

  const status: CiStatus = checkCiStatus(slug, sha);

  // Learn that this project has CI the moment we observe any check-run, and
  // clear a stale no-runs grace stamp for this SHA now that runs exist.
  if (status.kind === "success" || status.kind === "failed" || status.kind === "pending") {
    projectHasCi.set(projectName, true);
    ciNoRunsSince.delete(`${projectName}:${sha}`);
  }

  switch (status.kind) {
    case "success":
      log.info("poller", "ci gate passed", {
        worker: entry.name,
        data: { project: projectName, sha: sha.slice(0, 7) },
      });
      return true;

    case "no-ci": {
      // On a project known to have CI, zero check-runs means they haven't
      // materialized yet (we may have queried within seconds of a reviewer-fix
      // / ci-fix force-push). Defer so the freshly-amended commit is actually
      // gated — up to a grace ceiling, after which we accept there are none.
      // Projects that genuinely have no CI (never saw a check-run) pass through
      // immediately, so a no-CI merge is never delayed.
      if (projectHasCi.get(projectName) === true) {
        const key = `${projectName}:${sha}`;
        let since = ciNoRunsSince.get(key);
        if (since === undefined) { since = Date.now(); ciNoRunsSince.set(key, since); }
        if (Date.now() - since < CI_NO_RUNS_GRACE_MS) {
          log.info("poller", "ci gate: check-runs not yet materialized on a CI project, deferring", {
            worker: entry.name,
            data: { project: projectName, sha: sha.slice(0, 7) },
          });
          armCiRecheck(projectName);
          return false;
        }
        log.warn("poller", "ci gate: still no check-runs after grace on a CI project, passing through", {
          worker: entry.name,
          data: { project: projectName, sha: sha.slice(0, 7) },
        });
        ciNoRunsSince.delete(key);
        return true;
      }
      log.debug("poller", "ci gate: no check-runs on commit, skipping", {
        worker: entry.name,
        data: { project: projectName, sha: sha.slice(0, 7) },
      });
      return true;
    }

    case "unavailable":
      // Don't block on infrastructure problems. One alert per reason to
      // surface the gap without spamming on every poll cycle.
      log.warn("poller", "ci gate unavailable, passing through", {
        worker: entry.name,
        data: { project: projectName, reason: status.reason },
      });
      addAlert({
        level: "warn",
        source: "poller",
        project: projectName,
        worker: entry.name,
        message: `CI gate skipped (${status.reason}). Merging without GitHub Actions verification.`,
        dedupKey: `ci-gate-unavailable:${projectName}:${status.reason}`,
      });
      return true;

    case "pending": {
      log.info("poller", "ci gate: checks pending, deferring merge", {
        worker: entry.name,
        data: { project: projectName, sha: sha.slice(0, 7), pending: status.pending },
      });
      armCiRecheck(projectName);
      return false;
    }

    case "failed": {
      log.error("poller", "ci gate: checks failed, dispatching ci-fix", {
        worker: entry.name,
        data: { project: projectName, sha: sha.slice(0, 7), failed: status.failed },
      });
      // Hand off to the ci-fix agent. launchCiFix fires its own per-SHA
      // lifecycle alert (warn, "CI fix-agent launched...") and transitions
      // the worker to `ci-fixing`. If the budget is already exhausted
      // (third failure on the same SHA), it escalates internally to
      // `failing` with reason "ci" and an error alert — preserving the
      // pre-self-heal terminal behavior. Returns true in both cases so the
      // caller defers the merge; only returns false if launch could not
      // proceed (worker Claude busy, prompt-build failure), in which case
      // we leave the worker in merge-pending and the next FIFO event will
      // re-try.
      launchCiFix(projectName, projectPath, _baseBranch, entry, status.failed, sha);
      return false;
    }
  }
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
    const failCount = (entry.failCount ?? 0) + 1;
    log.error("poller", "merge failed", {
      worker: entry.name,
      data: { project: projectName, error: String(err), attempt: failCount },
    });
    if (failCount >= MAX_MERGE_RETRIES) {
      // Persistent failure — stop re-reviewing on every cycle (each retry burns
      // a full review) and park the worker in a visible, operator-actionable
      // state. `transient-review` so `garden kick` re-queues it without
      // demanding a new commit; the alert carries the real cause.
      addAlert({
        level: "error",
        source: "poller",
        project: projectName,
        worker: entry.name,
        message: `Merge failed for worker ${entry.name}; ${failCount} consecutive failures reached the retry budget (${MAX_MERGE_RETRIES}). Not retrying automatically — check for a diverged base or branch protection; 'garden kick' retries: ${String(err).slice(0, 200)}`,
        dedupKey: `merge-failed:${projectName}:${entry.name}`,
      });
      // Pin failingSha so handleFailing keeps the worker parked (its
      // stay-parked guard requires it) instead of debouncing back to
      // `working` — the point of the escalation is to stop automatic retries
      // until the operator kicks it or pushes a new commit.
      const headSha = getBranchHeadSha(entry.worktreePath ?? projectPath);
      transitionState(projectName, entry.name, "failing", {
        failCount,
        failingReason: "transient-review",
        failingSha: headSha ?? undefined,
        lastSeenSha: headSha ?? undefined,
        lastShaChangeAt: new Date().toISOString(),
        mergePendingAt: undefined,
      });
      refreshDashboard();
      return;
    }
    addAlert({
      level: "warn",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Merge failed for worker ${entry.name} (attempt ${failCount}/${MAX_MERGE_RETRIES}); re-queuing a review to retry: ${String(err).slice(0, 200)}`,
      dedupKey: `merge-retry:${projectName}:${entry.name}`,
    });
    // Set pendingReviewAt so the worker gets re-reviewed instead of being
    // stuck in "working" with no trigger to advance; count the failure so a
    // persistent one escalates instead of looping forever.
    transitionState(projectName, entry.name, "working", {
      pendingReviewAt: Date.now(),
      failCount,
      mergePendingAt: undefined,
      // Fresh cycle: reset the resolver budget and stale resolve state, matching
      // the force-push re-arm paths (tryForcePushAfterReview / after-resolve).
      // Without this, a resolver-verified branch that reaches this merge failure
      // with resolveAttempts already at budget would, after re-review, hit
      // escalateResolveBudget on the next genuine conflict without ever
      // launching a resolver.
      resolveAttempts: 0,
      preResolveSha: undefined,
      lastResolveBody: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 5_000);
    return;
  }

  log.info("poller", "merged to base branch", { worker: entry.name, data: { project: projectName, baseBranch } });

  completeFinalization(projectName, projectPath, baseBranch, entry, preMergeChangedFiles, false);
}

// Resume a merge whose base push already landed but whose finalization was
// interrupted before the terminal-state transition (see the resume check in
// handleMergePending). The remote branch may already be deleted and the
// worktree is already at the merged tip, so we skip the re-merge and the
// remote worktree sync and run only the idempotent post-merge tail.
function resumeInterruptedMerge(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): void {
  log.info("poller", "merge already on base, resuming interrupted finalization", {
    worker: entry.name,
    data: { project: projectName, baseBranch },
  });
  completeFinalization(projectName, projectPath, baseBranch, entry, [], true);
}

// The post-merge tail shared by a fresh merge and a resumed one: sync the
// worktree to the merged tip (skipped on resume — the worktree is already
// there and the remote branch may be gone), then run the project-wide
// side-effects and write the terminal state. `alreadyMerged` distinguishes
// the two callers.
function completeFinalization(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  preMergeChangedFiles: string[],
  alreadyMerged: boolean,
): void {
  const branchName = entry.branchName ?? entry.name;
  const sentinelPresent = isDoneSet(entry.worktreePath);
  const sync: SyncOutcome = alreadyMerged
    ? { changedFiles: [], syncFailed: false }
    : syncWorktreeAfterMerge(projectName, branchName, entry, sentinelPresent);
  notifyPostMerge(projectName, projectPath, baseBranch, entry, preMergeChangedFiles);
  transitionToTerminal(projectName, projectPath, baseBranch, branchName, entry, sentinelPresent, sync, preMergeChangedFiles);
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
      data: { project: projectName, branch: branchName },
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
  const logData = { project: projectName, branch: branchName, reason: sync.reason, error: sync.error };
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
// delete the remote branch, advance the local base ref to the merged tip
// (moving the working tree too when the base is the checked-out branch),
// notify any siblings whose branches overlap, run postMerge if configured
// (only when the working tree advanced), and alert on a genuine anomaly
// (diverged / checked-out-elsewhere / stuck — a clean off-base ref advance
// is silent).
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
  const ffResult = fastForwardBase(projectPath, baseBranch, { project: projectName, worker: entry.name });

  notifySiblingWorkers(projectName, baseBranch, entry, preMergeChangedFiles);

  // Alert only when the checkout *enters* an un-advanceable state (or switches
  // failure modes). A diverged/dirty checkout stays that way, so re-alerting on
  // every merge cycle is noise — origin already has the work; the operator
  // reconciles once. Recovery resets the memory so the next break re-alerts.
  const ffStateKey = `${projectName}:${baseBranch}`;
  const prevFfState = lastFfState.get(ffStateKey);
  const currFfState = ffResult.ok ? "ok" : ffResult.reason;
  lastFfState.set(ffStateKey, currFfState);

  if (ffResult.ok) {
    // Run postMerge only when the working tree itself advanced. An off-base
    // ref advance (advanced: "ref") left the working tree on a different
    // branch — building it would build the wrong branch, so skip postMerge.
    // No alert either: parking the checkout off the worker's base while the
    // ref trails origin is the deliberate many-base workflow, not drift.
    if (ffResult.advanced === "worktree") runPostMerge(projectName, projectPath);
    return;
  }
  if (currFfState === prevFfState) return;

  // The remote merge already landed; only the local base checkout lagged, and
  // the benign cases (off-base ref trailed origin; redundant local commit
  // auto-healed) returned ok above. What remains are states the operator should
  // know about — all framed as "merge succeeded, local checkout needs a hand":
  //   - diverged: local base has its own commits not on origin (warn).
  //   - checked-out-elsewhere: base is live in another worktree (warn).
  //   - dirty: uncommitted local changes collide with the merge (warn).
  //   - stuck: a fetch failure or wedged checkout (error — infra, not workflow).
  const postMergeNote = tryGetProject(projectName)?.postMerge
    ? " postMerge was skipped."
    : "";
  let level: "warn" | "error";
  let message: string;
  if (ffResult.reason === "diverged") {
    level = "warn";
    message = `Worker ${entry.name} merged to origin/${baseBranch}, but the local ${baseBranch} ref at ${projectPath} has diverged from origin (${ffResult.ahead} ahead, ${ffResult.behind} behind) and was left untouched. origin/${baseBranch} holds the merged work; reconcile the local ref by hand (rebase or reset it onto origin/${baseBranch} once you've confirmed the ${ffResult.ahead} local-only commit(s) are safe to drop).${postMergeNote}`;
  } else if (ffResult.reason === "checked-out-elsewhere") {
    level = "warn";
    const where = ffResult.checkedOutAt ? ` (${ffResult.checkedOutAt})` : "";
    message = `Worker ${entry.name} merged to origin/${baseBranch}, but ${baseBranch} is checked out in another worktree${where}, so its local ref was left untouched. Run \`git pull --ff-only\` in that worktree to pick up the merged work.${postMergeNote}`;
  } else if (ffResult.reason === "dirty") {
    level = "warn";
    message = `Worker ${entry.name} merged to origin/${baseBranch}, but the local ${baseBranch} checkout at ${projectPath} has uncommitted changes, so it was left untouched. origin/${baseBranch} holds the merged work; commit, stash, or discard the local changes to let it fast-forward.${postMergeNote}`;
  } else {
    level = "error";
    message = `Worker ${entry.name} merged to origin/${baseBranch}, but the local ${baseBranch} checkout at ${projectPath} could not be advanced (fetch failed or the checkout is wedged).${postMergeNote} origin/${baseBranch} holds the merged work; resolve the checkout so it stays current.`;
  }
  (level === "error" ? log.error : log.warn)("poller", "local base ref not advanced after merge", {
    worker: entry.name,
    data: { project: projectName, projectPath, baseBranch, reason: ffResult.reason },
  });
  addAlert({
    level,
    source: "poller",
    project: projectName,
    worker: entry.name,
    message,
    // Entry-gated above, so this only fires on a state change. Key on reason as
    // a second guard so a transition between failure modes is never suppressed.
    dedupKey: `ff-fail:${ffResult.reason}:${projectName}:${baseBranch}`,
  });
}

// Phase 3 of finalizeMerge: write the terminal prState (`done` when the
// worker self-declared finished via .garden-done, else `merged`) plus the
// per-merge field reset, handle the worker-already-working race, and
// dispatch the post-merge auto-continue prompt.
function transitionToTerminal(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  branchName: string,
  entry: WorkerEntry,
  sentinelPresent: boolean,
  sync: SyncOutcome,
  preMergeChangedFiles: string[],
): void {
  // Per STATUS.md invariant 4: pick `done` when the worker wrote .garden-done
  // before its final push (skip the transient `merged` beat and go straight
  // to the operator-actionable cleanup signal). Otherwise set `merged` —
  // auto-continue clears it on the next prompt.
  const terminalState: PrState = sentinelPresent ? "done" : "merged";
  // Holistic-review bookkeeping (folded into the same terminal write so it is
  // atomic with the prState change). mergeCount counts every completed merge
  // — both `merged` (intermediate phase) and `done` (final) outcomes; the
  // grow direct-done path bypasses this function and so never increments.
  // holisticTouchedFiles accumulates the union of each cycle's pre-merge diff
  // so a later whole-task review can scope to files this worker touched.
  const mergeCount = (entry.mergeCount ?? 0) + 1;
  const holisticTouchedFiles = [
    ...new Set([...(entry.holisticTouchedFiles ?? []), ...preMergeChangedFiles]),
  ];
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
    // The ci-fix per-merge-cycle budget must reset on a successful merge, same
    // as resolveAttempts above — registry.ts documents ciFixAttempts as
    // "resets on worker push or successful merge", but the successful-merge half
    // was never implemented, so a multi-phase worker accumulated attempts across
    // cycles until launchCiFix refused with a spurious "exhausted" alert.
    ciFixAttempts: 0,
    preCiFixSha: undefined,
    lastCiFixBody: undefined,
    failingCheckSummary: undefined,
    preReviewSha: undefined,
    mergeCount,
    holisticTouchedFiles,
    pendingContinueChangedFiles: sync.changedFiles.length ? sync.changedFiles : undefined,
    pendingContinueSyncFailed: sync.syncFailed ? true : undefined,
  });

  // STATUS.md invariant 4 race: a prompt hook that landed mid-merge can't
  // clear an active pipeline prState (which `merged`/`done` is at the moment
  // of write). If the worker is already working again, clear the stale
  // terminal state immediately so the renderer doesn't show a phantom merge.
  const fresh = findWorkerByName(projectName, entry.name);
  if (fresh?.agentStatus === "working") {
    log.info("poller", "worker active again, clearing merge state", {
      worker: entry.name,
      data: { project: projectName, clearedFrom: terminalState },
    });
    transitionState(projectName, entry.name, "working", {
      mergedAt: undefined,
      lastSeenSha: undefined,
    });
  }

  maybeAutoContinue(projectName, branchName, fresh ?? entry);

  // Merge-driven holistic trigger site: a worker that wrote .garden-done before
  // its final push lands `done` here (the sentinel-on-last-phase shape, e.g.
  // brown-blunt-flock). Re-read post-maybeAutoContinue — if the worker resumed
  // (settled back to working), it is mid-task and not a completion. The gate
  // (>=2 merges, default workflow) and the high-water guard live inside the
  // dispatcher. The trail-off shape (no final merge) is handled by handleDone.
  const settled = findWorkerByName(projectName, entry.name) ?? fresh ?? entry;
  if (settled.prState === "done") {
    maybeDispatchHolisticReview(projectName, projectPath, baseBranch, settled, "transitionToTerminal");
  }
}

// Merged-state handler (shared by every workflow). Two legs:
//
// 1. Recovery: if commits appear before UserPromptSubmit clears the
//    transient `merged`, treat that as a new work cycle and resume.
// 2. Gate-reopen sweep: maybeAutoContinue is one-shot at merge time, so a
//    worker whose continue prompt was blocked by the global gate (or whose
//    paste never landed) parks in `merged` with no replay. Re-running the
//    same decision on every poke delivers the stranded prompt on the first
//    poke after the gate reopens. The sweep trigger widens the idempotency
//    window to SWEEP_STRANDED_MS so it never double-dispatches against a
//    merge-time delivery still in flight, and skips exited workers (no
//    live Claude pane to paste into).
export function handleMerged(
  projectName: string,
  _projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath;
  if (!wtPath) return false;

  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (commitSummary) {
    log.info("poller", "new commits after merge, resuming", {
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

  return maybeAutoContinue(projectName, entry.branchName ?? entry.name, entry, "sweep");
}

// After a clean merge, send the worker a "please proceed" prompt so multi-phase
// work continues without manual intervention. The worker opts out by writing
// the .garden-done sentinel (see continue.ts donePath); pause/resume commands toggle
// the same file. Skips when the worker is already mid-turn or when the same
// merge event would re-fire within the trigger's idempotency window.
//
// trigger "merge" is the one-shot call from finalizeMerge; trigger "sweep"
// is handleMerged replaying the decision on every poke for a worker still
// parked in `merged`. The sweep logs gate blocks at debug — a closed gate
// would otherwise emit one info line per stranded worker per poke.
function maybeAutoContinue(
  projectName: string,
  branchName: string,
  entry: WorkerEntry,
  trigger: "merge" | "sweep" = "merge",
): boolean {
  const perWorkerReason = autoContinueSkipReason(entry, trigger);
  if (perWorkerReason) {
    log.debug("poller", "auto-continue skipped", {
      worker: entry.name,
      data: { project: projectName, reason: perWorkerReason, trigger },
    });
    return false;
  }
  const gateReason = autoContinueGateReason();
  if (gateReason) {
    const logGateBlock = trigger === "sweep" ? log.debug : log.info;
    logGateBlock("poller", "auto-continue blocked by global gate", {
      worker: entry.name,
      data: { project: projectName, reason: gateReason, trigger },
    });
    return false;
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
      return true;
    }
  }
  updateWorkerFields(projectName, entry.name, { lastAutoContinueAt: Date.now() });
  log.info("poller", "auto-continued worker after merge", {
    worker: entry.name,
    data: {
      project: projectName,
      branch: branchName,
      workflow: entry.workflow ?? "default",
      trigger,
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
  return true;
}

function autoContinueSkipReason(
  entry: WorkerEntry,
  trigger: "merge" | "sweep",
): string | null {
  if (isDoneSet(entry.worktreePath)) return "done-sentinel";
  if (entry.agentStatus === "working" || entry.agentStatus === "asking") {
    return `claude-${entry.agentStatus}`;
  }
  // Sweep-only: a dead pane has no Claude to paste into — reviving an
  // exited worker is bounce territory, not the sweep's.
  if (trigger === "sweep" && entry.agentStatus === "exited") {
    return "claude-exited";
  }
  const window = trigger === "sweep" ? SWEEP_STRANDED_MS : AUTO_CONTINUE_DEBOUNCE_MS;
  if (entry.lastAutoContinueAt
      && Date.now() - entry.lastAutoContinueAt < window) {
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
  // Provider-only fleet: the Anthropic snapshot is no longer refreshed
  // (Phase 1 gating), so whatever is on disk is stale by construction —
  // a gate decision based on it would pause/resume against meters that
  // describe nothing the fleet uses.
  try { if (!anyAnthropicMeteredProject()) return null; } catch { /* config unavailable: keep gate */ }
  const snap = readUsageSnapshot();
  const candidates = snapshotMeters(snap).filter(m => m.key !== "sonnet");
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
      log.info("poller", "garden rebuilt", { data: { project: projectName, commit } });
    } else {
      log.info("poller", "postMerge completed", { data: { project: projectName, commit } });
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
      data: { project: projectName, commit, error: String(err) },
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

    // Liveness from the registry (agentStatus is hook-driven). A sibling
    // marked exited is dead — skip.
    if (sibling.agentStatus === "exited") {
      log.info("poller", "skipping dead sibling", {
        worker: sibling.name,
        data: { project: projectName, mergedWorker: mergedEntry.name },
      });
      continue;
    }

    // Sentinel-set sibling self-declared done. prState may not yet reflect
    // that (the worker wrote .garden-done but neither finalizeMerge nor the
    // Stop hook has transitioned them to `done` yet — see STATUS.md
    // invariant 4 paths into `done`). Notifying here just burns tokens.
    if (isDoneSet(sibling.worktreePath)) {
      log.info("poller", "skipping done sibling (sentinel set)", {
        worker: sibling.name,
        data: { project: projectName, mergedWorker: mergedEntry.name },
      });
      continue;
    }

    // Delivery dialect belongs to the sibling's harness (TUI paste
    // semantics differ per agent CLI).
    getHarnessCore(sibling.harness).deliverPrompt(paneId, message);
    log.info("poller", "notified sibling of merge overlap", {
      worker: sibling.name,
      data: { project: projectName, mergedWorker: mergedEntry.name, overlapFiles: overlap },
    });
  }
}
