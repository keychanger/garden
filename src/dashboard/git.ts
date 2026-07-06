// Git operations for worktree-based workers.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { SESSIONS_DIR } from "../config.js";
import type { WorkerEntry } from "./registry.js";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";

const WORKTREE_BASE = path.join(
  process.env.HOME ?? "",
  ".garden",
  "worktrees",
);

export function resolveBaseBranch(repoPath: string): string {
  // Use whatever branch is checked out in the main project directory —
  // that's the branch workers should merge into.
  const current = currentBranch(repoPath);
  if (current && current !== "HEAD") return current;
  try {
    const ref = git(repoPath, "symbolic-ref", "refs/remotes/origin/HEAD");
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    // origin/HEAD not set — common for --single-branch clones
  }
  return "main";
}

// Returns true if the named branch is known on origin per local refs. Used
// to validate a candidate base branch at worker creation — a worker targeting
// a local-only branch breaks silently. Local-only (no `ls-remote`) so the ⌥n
// hotkey doesn't block on the network; the bootstrap's fresh `git fetch`
// raises a `bootstrap` alert if the branch has since vanished from origin.
export function branchExistsOnOrigin(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

export type PublishResult = { ok: true } | { ok: false; error: string };

// Push <branchName> from the main checkout to origin so it gains an
// origin/<branchName> ref. Called when the operator triggers ⌥n while the
// main checkout is parked on a local-only branch — treat that as an explicit
// "publish this branch as the base for workers" gesture rather than refusing.
// The push creates the local remotes/origin/<branchName> ref as a side
// effect, which is exactly what branchExistsOnOrigin and the merge path
// need. Returns { ok: false, error } with the captured git stderr on
// failure (no remote, branch protection, non-fast-forward, network) so the
// caller can surface the real reason instead of a generic remediation hint.
export function tryPublishBranch(repoPath: string, branchName: string): PublishResult {
  try {
    git(repoPath, "push", "-u", "origin", branchName);
    log.info("git", "published branch to origin", { data: { branchName } });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr;
    const errText = (stderr ? String(stderr) : String(err)).trim();
    log.warn("git", "failed to publish branch", {
      data: { branchName, error: errText },
    });
    return { ok: false, error: errText };
  }
}

// True when the project's current HEAD has `.garden-done` tracked. A reviewer
// running `git add -A` while the sentinel sat in its CWD is how this happens
// (wolf, 2026-05-06). New workers then inherit the file via `git worktree
// add`, the first Stop hook trips terminal `done` from the file's mere
// presence, and post-merge auto-continue stays silent across every cycle on
// that project. The bootstrap defangs each new worktree, but the root fix
// is `git rm` on main — surface this to the operator via addAlert so the
// cleanup doesn't sit in a stderr line nobody reads.
export function gardenDoneTrackedInHead(repoPath: string): boolean {
  try {
    const out = git(repoPath, "ls-tree", "HEAD", ".garden-done");
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Return the worker's pinned base branch, falling back to current-checkout
// resolution for legacy workers that predate the pinning. New workers always
// carry entry.baseBranch; the fallback is only reached for entries written
// before the field existed.
export function getWorkerBaseBranch(
  entry: Pick<WorkerEntry, "baseBranch">,
  projectPath: string,
): string {
  if (entry.baseBranch) return entry.baseBranch;
  return resolveBaseBranch(projectPath);
}

export function worktreePath(project: string, workerName: string): string {
  return path.join(WORKTREE_BASE, project, workerName);
}


export function createWorktree(
  repoPath: string,
  wtPath: string,
  branchName: string,
): void {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(repoPath, "worktree", "add", wtPath, "-b", branchName);
  log.info("git", "created worktree", { data: { branchName } });
  installDeps(wtPath);
}

export function removeWorktree(repoPath: string, wtPath: string): void {
  try {
    git(repoPath, "worktree", "remove", wtPath, "--force");
    log.info("git", "removed worktree");
  } catch (err) {
    log.warn("git", "failed to remove worktree", {
      data: { error: String(err) },
    });
  }
}

export function worktreeExists(wtPath: string): boolean {
  try {
    return fs.existsSync(path.join(wtPath, ".git"));
  } catch {
    return false;
  }
}

export function deleteBranch(repoPath: string, branchName: string): void {
  try {
    git(repoPath, "branch", "-D", branchName);
    log.info("git", "deleted branch", { data: { branchName } });
  } catch (err) {
    log.warn("git", "failed to delete branch", {
      data: { branchName, error: String(err) },
    });
  }
}

export function getBranchHeadSha(wtPath: string): string | null {
  try {
    return git(wtPath, "rev-parse", "HEAD");
  } catch {
    return null;
  }
}

// Read the remote tracking ref for a branch. Unlike getBranchHeadSha (which
// reads the local HEAD), this reflects the last-pushed state. It is NOT
// affected by a local rebase, so the poller can use it to detect genuine
// worker pushes without false positives from the reviewer rebasing.
export function getRemoteTrackingSha(wtPath: string, branchName: string): string | null {
  try {
    return git(wtPath, "rev-parse", `origin/${branchName}`);
  } catch {
    return null;
  }
}

export function getDiffAgainstBase(wtPath: string, baseBranch: string): string {
  return git(wtPath, "diff", `origin/${baseBranch}...HEAD`);
}

export function cleanWorktree(
  worktreePath: string,
  ctx?: { project?: string; worker?: string },
): void {
  try {
    git(worktreePath, "checkout", "--", ".");
    log.info("git", "cleaned unstaged changes before rebase", {
      worker: ctx?.worker,
      data: ctx?.project ? { project: ctx.project } : undefined,
    });
  } catch {
    // nothing to clean
  }
}

export type RebaseResult =
  | { kind: "ok" }
  | { kind: "conflict" }
  | { kind: "error"; error: string };

export function rebaseBranch(worktreePath: string, baseBranch: string): RebaseResult {
  try {
    git(worktreePath, "rebase", `origin/${baseBranch}`);
    return { kind: "ok" };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("CONFLICT") || msg.includes("could not apply")) {
      return { kind: "conflict" };
    }
    return { kind: "error", error: msg };
  }
}

export function abortRebase(worktreePath: string): void {
  try {
    git(worktreePath, "rebase", "--abort");
  } catch {
    // may not be in a rebase state
  }
}

// True when a rebase is in progress (either interactive/merge-style or am-style).
// Used to detect leftover rebase state from a crashed or aborted resolver.
// Uses `git rev-parse --git-path` so it works in worktrees where `.git` is a
// file pointing at the shared repo, not a directory.
export function hasRebaseInProgress(worktreePath: string): boolean {
  try {
    const rebaseMerge = git(worktreePath, "rev-parse", "--git-path", "rebase-merge");
    if (fs.existsSync(path.resolve(worktreePath, rebaseMerge))) return true;
  } catch { /* ignore */ }
  try {
    const rebaseApply = git(worktreePath, "rev-parse", "--git-path", "rebase-apply");
    if (fs.existsSync(path.resolve(worktreePath, rebaseApply))) return true;
  } catch { /* ignore */ }
  return false;
}

// True when `ancestor` is an ancestor of `descendant` in the worktree's repo.
// Used by the resolver verification to confirm the branch is rebased onto base.
export function isAncestor(worktreePath: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// Ensure no rebase is in progress. If one is found, abort it. Belt-and-suspenders
// cleanup before the poller attempts a fresh rebase — recovers from a prior
// resolver that crashed or was killed mid-rebase.
export function ensureNoRebaseInProgress(worktreePath: string): void {
  if (hasRebaseInProgress(worktreePath)) {
    log.warn("git", "aborting leftover rebase before fresh attempt", {
      data: { worktreePath },
    });
    abortRebase(worktreePath);
  }
}

// Paths (relative to worktree root) currently in a merge-conflict state — i.e.
// files with unresolved conflict markers during a rebase/merge. Used in
// escalation alerts so the operator knows exactly where the resolver got stuck.
export function getUnmergedFiles(worktreePath: string): string[] {
  try {
    const out = git(worktreePath, "diff", "--name-only", "--diff-filter=U");
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function forcePushBranch(worktreePath: string, branch: string): void {
  // Push the worktree's actual HEAD to the named branch on origin, regardless
  // of which local branch is currently checked out. Without HEAD: in the
  // refspec, git pushes refs/heads/<branch> from the local repo, which can
  // be stale (or unmoved) if the worker has done its work on a different
  // local branch in the same worktree. The previous behavior caused the
  // poller to force-push a stale ref and loop forever in handleMerged when
  // a worker created a side branch — see worktree workflow rules in
  // src/rules.ts for the directive that prevents the same trap.
  git(worktreePath, "push", "--force-with-lease", "origin", `HEAD:${branch}`);
}

export function mergeToBase(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  ctx?: { project?: string; worker?: string },
): void {
  git(repoPath, "fetch", "origin");
  // Resolve to concrete SHAs so we can verify fast-forward and push without
  // needing a clean working tree or switching branches in the project checkout.
  const branchSha = git(repoPath, "rev-parse", `origin/${branchName}`);
  const baseSha = git(repoPath, "rev-parse", `origin/${baseBranch}`);
  // Verify fast-forward: branch must be a descendant of current base
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", baseSha, branchSha], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      `Cannot fast-forward: origin/${branchName} (${branchSha}) is not a descendant of origin/${baseBranch} (${baseSha})`,
    );
  }
  // Push directly to remote base branch — no local checkout or merge needed.
  git(repoPath, "push", "origin", `${branchSha}:refs/heads/${baseBranch}`);
  log.info("git", "merged to base branch", {
    worker: ctx?.worker,
    data: { branchName, baseBranch, ...(ctx?.project ? { project: ctx.project } : {}) },
  });
}

export type FastForwardResult =
  // `worktree`: the base branch was checked out, so `merge --ff-only` advanced
  // the working tree too — a configured postMerge can build it. `ref`: the
  // base was parked off to the side, so only its branch ref was advanced; the
  // working tree is on another branch and postMerge must be skipped.
  | { ok: true; advanced: "worktree" | "ref" }
  | { ok: false; reason: "diverged"; currentBranch: string | null; ahead: number; behind: number }
  | { ok: false; reason: "checked-out-elsewhere"; currentBranch: string | null; checkedOutAt: string | null }
  | { ok: false; reason: "dirty"; currentBranch: string | null; error: string }
  | { ok: false; reason: "stuck"; error: string };

// Advance the project's local base branch to the freshly-merged origin tip.
// Two shapes, because `git merge --ff-only` only ever moves HEAD:
//   - base IS the checked-out branch -> `merge --ff-only` updates the working
//     tree as well (advanced: "worktree").
//   - base is NOT checked out (the operator parked the project checkout on
//     another branch — the deliberate many-base workflow) -> advance the ref
//     alone with `git fetch origin <base>:<base>` (advanced: "ref"). That
//     refspec is both fast-forward-enforced (it rejects a non-ff update — real
//     divergence) and worktree-aware (it refuses to move a branch checked out
//     in another worktree), so we never clobber local-only commits or desync a
//     sibling worktree. The common "ref simply trailed origin" case advances
//     silently; only genuine divergence or contention surfaces to the operator.
export function fastForwardBase(
  repoPath: string,
  baseBranch: string,
  ctx?: { project?: string; worker?: string },
): FastForwardResult {
  const worker = ctx?.worker;
  const baseData = { baseBranch, ...(ctx?.project ? { project: ctx.project } : {}) };
  const current = currentBranch(repoPath);
  if (current === baseBranch) {
    try {
      git(repoPath, "fetch", "origin", baseBranch);
    } catch (err) {
      return { ok: false, reason: "stuck", error: gitErrText(err) };
    }
    try {
      git(repoPath, "merge", "--ff-only", `origin/${baseBranch}`);
      log.info("git", "fast-forwarded local base checkout", { worker, data: baseData });
      return { ok: true, advanced: "worktree" };
    } catch (err) {
      const error = gitErrText(err);
      // ff-only refused. The base checkout is the operator's shared working
      // directory, not a pristine mirror, so this is expected — and benign for
      // merge correctness (the work already landed on origin; only the local
      // rebuild lags). Classify into three sub-cases instead of one `stuck`.
      const dirty = isWorktreeDirty(repoPath);
      if (dirty === false && treeMatchesOrigin(repoPath, baseBranch)) {
        // Clean tree whose committed content already equals origin/<base>: the
        // local-only commit(s) carry no unique content (e.g. an operator heal
        // commit whose change also merged the normal way). Reset onto origin —
        // the reflog preserves the dropped commits and the working tree doesn't
        // move, since its content already matches. Never reset a dirty tree:
        // that would destroy uncommitted operator work.
        try {
          git(repoPath, "reset", "--hard", `origin/${baseBranch}`);
          log.info("git", "auto-healed redundant local base divergence onto origin", {
            worker,
            data: baseData,
          });
          return { ok: true, advanced: "worktree" };
        } catch (resetErr) {
          return { ok: false, reason: "stuck", error: gitErrText(resetErr) };
        }
      }
      if (dirty === false) {
        // Clean tree carrying real local-only content: genuine divergence.
        // origin holds the merged work; the operator reconciles by hand.
        const { ahead, behind } = aheadBehind(repoPath, baseBranch, `origin/${baseBranch}`);
        log.debug("git", "local base checkout diverged from origin (postMerge skipped)", {
          worker,
          data: { ...baseData, ahead, behind },
        });
        return { ok: false, reason: "diverged", currentBranch: current, ahead, behind };
      }
      // Dirty (or status unknowable): uncommitted local changes collide with the
      // merge. Leave the checkout untouched rather than clobber operator edits.
      log.debug("git", "local base checkout dirty, not fast-forwarded (postMerge skipped)", {
        worker,
        data: { ...baseData, error },
      });
      return { ok: false, reason: "dirty", currentBranch: current, error };
    }
  }
  // Off-base: refresh the tracking ref (so divergence math below is accurate),
  // then advance the local branch ref without touching the working tree.
  try {
    git(repoPath, "fetch", "origin", baseBranch);
  } catch (err) {
    return { ok: false, reason: "stuck", error: gitErrText(err) };
  }
  try {
    git(repoPath, "fetch", "origin", `${baseBranch}:${baseBranch}`);
    log.info("git", "advanced off-base local base ref to origin", {
      worker,
      data: { ...baseData, currentBranch: current },
    });
    return { ok: true, advanced: "ref" };
  } catch (err) {
    const text = gitErrText(err);
    if (/refusing to fetch into branch|checked out at/.test(text)) {
      const checkedOutAt = text.match(/checked out at '([^']+)'/)?.[1] ?? null;
      log.info("git", "off-base base ref not advanced: checked out elsewhere", {
        worker,
        data: { ...baseData, currentBranch: current, checkedOutAt },
      });
      return { ok: false, reason: "checked-out-elsewhere", currentBranch: current, checkedOutAt };
    }
    if (/non-fast-forward|\[rejected\]/.test(text)) {
      const { ahead, behind } = aheadBehind(repoPath, baseBranch, `origin/${baseBranch}`);
      log.info("git", "off-base base ref not advanced: diverged from origin", {
        worker,
        data: { ...baseData, currentBranch: current, ahead, behind },
      });
      return { ok: false, reason: "diverged", currentBranch: current, ahead, behind };
    }
    return { ok: false, reason: "stuck", error: text };
  }
}

// Captured-stderr-first error text — execFileSync's own message omits the git
// stderr we need to classify the failure (non-fast-forward vs checked-out).
function gitErrText(err: unknown): string {
  const stderr = (err as { stderr?: string | Buffer }).stderr;
  return (stderr ? String(stderr) : String(err)).trim();
}

// True when the checkout's committed tree (HEAD) is byte-identical to
// origin/<base> — i.e. its local-only commits introduce no content origin
// lacks. `git diff --quiet` exits 0 on an identical tree (no throw) and
// non-zero otherwise (throw); any error is treated as "not identical" so the
// caller never resets onto origin under uncertainty.
function treeMatchesOrigin(repoPath: string, baseBranch: string): boolean {
  try {
    git(repoPath, "diff", "--quiet", "HEAD", `origin/${baseBranch}`);
    return true;
  } catch {
    return false;
  }
}

// Commit counts on either side of a divergence: `<local>...<remote>` left/right
// is (local-only, remote-only). Reported in the divergence alert so the
// operator sees how much local-only history they'd drop before reconciling.
function aheadBehind(
  repoPath: string,
  local: string,
  remote: string,
): { ahead: number; behind: number } {
  try {
    const out = git(repoPath, "rev-list", "--left-right", "--count", `${local}...${remote}`);
    const [a, b] = out.split(/\s+/);
    return { ahead: Number(a) || 0, behind: Number(b) || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export function deleteRemoteBranch(
  repoPath: string,
  branchName: string,
  ctx?: { project?: string; worker?: string },
): void {
  const projectData = ctx?.project ? { project: ctx.project } : {};
  try {
    const refs = git(repoPath, "ls-remote", "--heads", "origin", branchName);
    if (!refs.trim()) return;
    git(repoPath, "push", "origin", "--delete", branchName);
    log.info("git", "deleted remote branch", {
      worker: ctx?.worker,
      data: { branchName, ...projectData },
    });
  } catch (err) {
    log.warn("git", "failed to delete remote branch", {
      worker: ctx?.worker,
      data: { branchName, error: String(err), ...projectData },
    });
  }
}

export function getChangedFiles(wtPath: string, baseBranch: string): string[] {
  try {
    const result = git(wtPath, "diff", "--name-only", `origin/${baseBranch}...HEAD`);
    return result.split("\n").filter(Boolean);
  } catch (err) {
    log.warn("git", "getChangedFiles failed", { data: { baseBranch, error: String(err) } });
    return [];
  }
}

export function getChangedFilesBetween(
  wtPath: string,
  fromSha: string,
  toSha: string,
): string[] {
  try {
    const result = git(wtPath, "diff", "--name-only", `${fromSha}..${toSha}`);
    return result.split("\n").filter(Boolean);
  } catch (err) {
    log.warn("git", "getChangedFilesBetween failed", {
      data: { fromSha, toSha, error: String(err) },
    });
    return [];
  }
}

// `git diff --stat from..to` as a human-readable block (files + insertion/
// deletion counts), for `garden review`. Empty string on a no-op range (a
// CLEAN review, where the reviewer pushed nothing) or any git failure.
export function getDiffStat(
  wtPath: string,
  fromSha: string,
  toSha: string,
): string {
  try {
    return git(wtPath, "diff", "--stat", `${fromSha}..${toSha}`).trim();
  } catch (err) {
    log.warn("git", "getDiffStat failed", {
      data: { fromSha, toSha, error: String(err) },
    });
    return "";
  }
}

// Commit log across an arbitrary SHA range, optionally scoped to a file set.
// The whole-task rationale source for holistic review: unlike getCommitSummary
// (origin/<base>..HEAD, which is empty once the worktree is synced to the
// merged tip), this takes explicit endpoints so it stays populated at `done`.
export function getCommitLogRange(
  wtPath: string,
  fromSha: string,
  toSha: string,
  files?: string[],
): string {
  try {
    const args = ["log", "--oneline", `${fromSha}..${toSha}`];
    if (files && files.length > 0) args.push("--", ...files);
    return git(wtPath, ...args);
  } catch (err) {
    log.warn("git", "getCommitLogRange failed", {
      data: { fromSha, toSha, error: String(err) },
    });
    return "";
  }
}

// The production whole-task diff-scoping function, shared by the live holistic
// dispatcher and the offline backtest harness so both exercise one code path.
// Computes the cumulative diff from a worker's creation-time base SHA to the
// assembled tip, scoped to the union of files the worker touched. The scoping
// suppresses sibling-merge noise that advanced the base in between; its known
// limitation (blind to ripple into untouched files) is documented in the
// holistic worker's brief.
export function resolveHolisticDiff(
  wtPath: string,
  fromSha: string,
  toRef: string,
  touchedFiles: string[],
): string {
  try {
    const args = ["diff", `${fromSha}..${toRef}`];
    if (touchedFiles.length > 0) args.push("--", ...touchedFiles);
    return git(wtPath, ...args);
  } catch (err) {
    log.warn("git", "resolveHolisticDiff failed", {
      data: { fromSha, toRef, error: String(err) },
    });
    return "";
  }
}

export type SyncWorktreeResult =
  | { ok: true }
  | { ok: false; reason: "dirty" | "fetch-failed" | "reset-failed"; error?: string };

// Sync a worker's worktree to the latest remote tip of its branch. Used after
// a merge to discard the worker's pre-review HEAD and adopt the reviewer's
// force-pushed (and now-merged) version. Refuses to clobber uncommitted local
// changes — those are rare (the worker just finished its turn) but we don't
// want to silently nuke operator-typed edits.
export function syncWorktreeToRemote(
  wtPath: string,
  branchName: string,
): SyncWorktreeResult {
  try {
    const dirty = git(wtPath, "status", "--porcelain");
    if (dirty) return { ok: false, reason: "dirty" };
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    git(wtPath, "fetch", "origin", branchName);
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    git(wtPath, "reset", "--hard", `origin/${branchName}`);
  } catch (err) {
    return { ok: false, reason: "reset-failed", error: String(err) };
  }
  return { ok: true };
}

// Fast-forward a worker's worktree to the latest remote tip of the base
// branch. Used by `garden workers grow` when the worker's branch was already
// fully merged before the convert: the local branch tip equals its old
// merged commit, but `origin/<base>` may have advanced from sibling merges
// since. `merge --ff-only` enforces "strict ancestor" — if siblings have
// pushed commits that touched the same files in a way that would require a
// real merge, we surface that rather than clobbering with `reset --hard`.
export function syncWorktreeToBase(
  wtPath: string,
  baseBranch: string,
): SyncWorktreeResult {
  try {
    const dirty = git(wtPath, "status", "--porcelain");
    if (dirty) return { ok: false, reason: "dirty" };
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    git(wtPath, "fetch", "origin", baseBranch);
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    git(wtPath, "merge", "--ff-only", `origin/${baseBranch}`);
  } catch (err) {
    return { ok: false, reason: "reset-failed", error: String(err) };
  }
  return { ok: true };
}

// Returns true if the worktree has uncommitted changes (tracked or
// untracked-not-gitignored). Thin wrapper over `git status --porcelain` —
// non-empty output means dirty. Returns null if the git invocation fails
// (path isn't a worktree, git unavailable, etc.) so callers can distinguish
// "definitely clean" from "couldn't determine".
export function isWorktreeDirty(wtPath: string): boolean | null {
  try {
    return git(wtPath, "status", "--porcelain").length > 0;
  } catch {
    return null;
  }
}

// Returns the number of commits the worker's HEAD is ahead of
// `origin/<baseBranch>`. Used by `garden workers grow` to decide whether
// the worker still has unmerged work to push (in which case the next merge
// fires the grow auto-continue) or is fully merged (in which case the
// convert command must dispatch iter-1 itself). Returns null if the count
// can't be determined — typically because the path isn't a git worktree
// or `origin/<baseBranch>` doesn't exist locally.
export function countCommitsAheadOfBase(
  wtPath: string,
  baseBranch: string,
): number | null {
  try {
    const out = git(wtPath, "rev-list", "--count", `origin/${baseBranch}..HEAD`);
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function getCommitSummary(wtPath: string, baseBranch: string): string {
  try {
    return execFileSync("git", [
      "log", "--oneline", `origin/${baseBranch}..HEAD`,
    ], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch (err) {
    log.warn("git", "getCommitSummary failed", { data: { baseBranch, error: String(err) } });
    return "";
  }
}

// Does the worktree HEAD have commits ahead of origin/<base>? Returns a
// boolean on success, or null when the git call itself failed (error/timeout).
// Callers that gate a review launch on "are there commits" MUST distinguish
// null from false: getCommitSummary returns "" for both, so treating its empty
// result as "no commits" lets a transient git failure permanently cancel a
// pending review. rev-list --count is cheaper than log --oneline and all the
// caller needs is the yes/no.
export function hasCommitsAhead(wtPath: string, baseBranch: string): boolean | null {
  try {
    const out = execFileSync("git", [
      "rev-list", "--count", `origin/${baseBranch}..HEAD`,
    ], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    return parseInt(out, 10) > 0;
  } catch (err) {
    log.warn("git", "hasCommitsAhead failed", { data: { baseBranch, error: String(err) } });
    return null;
  }
}

export function getNewCommitSummary(wtPath: string, sinceSha: string | undefined): string {
  if (!sinceSha) return "";
  try {
    return execFileSync("git", [
      "log", "--oneline", `${sinceSha}..HEAD`,
    ], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch (err) {
    log.warn("git", "getNewCommitSummary failed", { data: { sinceSha, error: String(err) } });
    return "";
  }
}

export function pruneWorktrees(repoPath: string): void {
  try {
    git(repoPath, "worktree", "prune");
  } catch {
    // best effort
  }
}

export function installPollTriggerHook(wtPath: string, _gardenRunner: string, projectName: string): void {
  const hooksDir = path.join(wtPath, ".garden-hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const signalFifo = path.join(SESSIONS_DIR, `${projectName}-poll-signal`);

  const hookScript = [
    "#!/bin/sh",
    `# Signal the poller immediately`,
    `FIFO="${signalFifo}"`,
    `if [ -p "$FIFO" ]; then`,
    `  (echo > "$FIFO") </dev/null >/dev/null 2>&1 &`,
    `fi`,
    `exit 0`,
    "",
  ].join("\n");

  // Atomic write: git reads pre-push on every push, and a worker mid-push
  // could otherwise see a half-written script and silently skip the FIFO
  // signal. Practical risk is near-zero (install runs once at worker
  // creation, before the worker has anything to push) but the cost is
  // a single function swap.
  atomicWriteFile(hookPath, hookScript, { mode: 0o755 });
  git(wtPath, "config", "--local", "core.hooksPath", hooksDir);
  log.info("git", "installed poll trigger hook");
}

function installDeps(wtPath: string): void {
  if (fs.existsSync(path.join(wtPath, "package.json"))) {
    try {
      execFileSync("npm", ["install"], {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      log.info("git", "installed npm dependencies");
    } catch (err) {
      log.warn("git", "failed to install npm dependencies", {
        data: { error: String(err) },
      });
    }
  }
  if (fs.existsSync(path.join(wtPath, "pyproject.toml"))) {
    try {
      const contents = fs.readFileSync(
        path.join(wtPath, "pyproject.toml"),
        "utf-8",
      );
      if (!contents.includes("[tool.poetry]")) return;
      execFileSync("poetry", ["install", "--no-interaction"], {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
      log.info("git", "installed poetry dependencies");
    } catch (err) {
      log.warn("git", "failed to install poetry dependencies", {
        data: { error: String(err) },
      });
    }
  }
}

export function currentBranch(repoPath: string): string | null {
  try {
    return git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
  } catch {
    return null;
  }
}

// Extract the host from the origin remote URL. Handles both ssh-style
// (git@host:owner/repo.git) and https-style (https://host/owner/repo.git)
// forms. Returns null if there is no origin or the URL can't be parsed.
export function getRemoteHost(repoPath: string): string | null {
  let url: string;
  try {
    url = git(repoPath, "config", "--get", "remote.origin.url");
  } catch {
    return null;
  }
  if (!url) return null;
  const sshMatch = url.match(/^[^@]+@([^:]+):/);
  if (sshMatch) return sshMatch[1];
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}
