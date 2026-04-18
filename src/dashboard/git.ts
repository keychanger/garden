// Git operations for worktree-based workers.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { SESSIONS_DIR, type ProjectConfig } from "../config.js";
import type { WorkerEntry } from "./registry.js";
import { log } from "./log.js";

const WORKTREE_BASE = path.join(
  process.env.HOME ?? "",
  ".garden",
  "worktrees",
);

export function resolveBaseBranch(repoPath: string, projectConfig?: Pick<ProjectConfig, "baseBranch">): string {
  if (projectConfig?.baseBranch) return projectConfig.baseBranch;
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

// Returns true if the named branch exists on the origin remote. Used to
// validate a candidate base branch at worker creation — a worker targeting a
// local-only branch breaks silently (every `origin/<base>..HEAD` check fails),
// so we reject it up front.
export function branchExistsOnOrigin(repoPath: string, branchName: string): boolean {
  try {
    const out = git(repoPath, "ls-remote", "--heads", "origin", branchName);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Return the worker's pinned base branch, falling back to project-level
// resolution for legacy workers that predate the pinning. New workers always
// carry entry.baseBranch; the fallback is only reached for entries written
// before the field existed.
export function getWorkerBaseBranch(
  entry: Pick<WorkerEntry, "baseBranch">,
  projectPath: string,
  projectConfig?: Pick<ProjectConfig, "baseBranch">,
): string {
  if (entry.baseBranch) return entry.baseBranch;
  return resolveBaseBranch(projectPath, projectConfig);
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

export function cleanWorktree(worktreePath: string): void {
  try {
    // Exclude settings.local.json: on repos that track it, a plain checkout
    // would strip garden's hooks and wedge the worker on claudeStatus="working".
    git(
      worktreePath,
      "checkout",
      "--",
      ".",
      ":(exclude).claude/settings.local.json",
    );
    log.info("git", "cleaned unstaged changes before rebase", {
      data: { worktreePath },
    });
  } catch {
    // nothing to clean
  }
}

export type RebaseResult = "ok" | "conflict" | "error";

export function rebaseBranch(worktreePath: string, baseBranch: string): RebaseResult {
  try {
    git(worktreePath, "rebase", `origin/${baseBranch}`);
    return "ok";
  } catch (err) {
    const msg = String(err);
    // Actual merge conflicts mention CONFLICT or "could not apply"
    if (msg.includes("CONFLICT") || msg.includes("could not apply")) {
      return "conflict";
    }
    log.error("git", "rebase failed (not a conflict)", {
      data: { baseBranch, error: msg },
    });
    return "error";
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

export function mergeToBase(repoPath: string, branchName: string, baseBranch: string): void {
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
  log.info("git", "merged to base branch", { data: { branchName, baseBranch } });
}

export function fastForwardBase(
  repoPath: string,
  baseBranch: string,
  ctx?: { project?: string; worker?: string },
): boolean {
  const worker = ctx?.worker;
  const baseData = { baseBranch, ...(ctx?.project ? { project: ctx.project } : {}) };
  try {
    const current = currentBranch(repoPath);
    if (current !== baseBranch) {
      log.info("git", "skipping fast-forward: not on base branch", {
        worker,
        data: { ...baseData, currentBranch: current },
      });
      return false;
    }
    git(repoPath, "fetch", "origin", baseBranch);
    git(repoPath, "merge", "--ff-only", `origin/${baseBranch}`);
    log.info("git", "fast-forwarded local base branch", { worker, data: baseData });
    return true;
  } catch (err) {
    log.info("git", "local base checkout not fast-forwarded (postMerge will be skipped)", {
      worker,
      data: { ...baseData, error: String(err) },
    });
    return false;
  }
}

export function deleteRemoteBranch(repoPath: string, branchName: string): void {
  try {
    const refs = git(repoPath, "ls-remote", "--heads", "origin", branchName);
    if (!refs.trim()) return;
    git(repoPath, "push", "origin", "--delete", branchName);
    log.info("git", "deleted remote branch", { data: { branchName } });
  } catch (err) {
    log.warn("git", "failed to delete remote branch", {
      data: { branchName, error: String(err) },
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

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
  git(wtPath, "config", "--local", "core.hooksPath", hooksDir);
  log.info("git", "installed poll trigger hook");
}

function installDeps(wtPath: string): void {
  if (!fs.existsSync(path.join(wtPath, "package.json"))) return;
  try {
    execFileSync("npm", ["install"], {
      cwd: wtPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    log.info("git", "installed dependencies");
  } catch (err) {
    log.warn("git", "failed to install dependencies", {
      data: { error: String(err) },
    });
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
  }).trim();
}
