// Git operations for worktree-based workers.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { SESSIONS_DIR, type ProjectConfig } from "../config.js";
import { log } from "./log.js";

const WORKTREE_BASE = path.join(
  process.env.HOME ?? "",
  ".garden",
  "worktrees",
);

export function resolveBaseBranch(repoPath: string, projectConfig?: Pick<ProjectConfig, "baseBranch">): string {
  if (projectConfig?.baseBranch) return projectConfig.baseBranch;
  try {
    const ref = git(repoPath, "symbolic-ref", "refs/remotes/origin/HEAD");
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    // origin/HEAD not set — common for --single-branch clones
  }
  return "main";
}

export function worktreePath(project: string, workerName: string): string {
  return path.join(WORKTREE_BASE, project, workerName);
}

export function fastForwardBase(repoPath: string, baseBranch: string): void {
  try {
    git(repoPath, "fetch", "origin", baseBranch);
    git(repoPath, "merge", "--ff-only", `origin/${baseBranch}`);
    log.info("git", "fast-forwarded base branch", { data: { baseBranch } });
  } catch (err) {
    log.warn("git", "failed to fast-forward base branch", {
      data: { baseBranch, error: String(err) },
    });
  }
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

// Returns true if the worktree has any uncommitted changes — modified,
// staged, or untracked files. Returns false if the worktree is clean, the
// path doesn't exist, or git fails (defaulting to "not dirty" so a broken
// git state can't block the kill path).
export function isWorktreeDirty(wtPath: string): boolean {
  if (!worktreeExists(wtPath)) return false;
  try {
    const out = git(wtPath, "status", "--porcelain");
    return out.length > 0;
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
    git(worktreePath, "checkout", "--", ".");
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
  git(repoPath, "checkout", baseBranch);
  git(repoPath, "merge", "--ff-only", `origin/${branchName}`);
  git(repoPath, "push", "origin", baseBranch);
  log.info("git", "merged to base branch", { data: { branchName, baseBranch } });
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
  } catch {
    return [];
  }
}

export function getCommitSummary(wtPath: string, baseBranch: string): string {
  try {
    return execFileSync("git", [
      "log", "--oneline", `${baseBranch}..HEAD`,
    ], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch {
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
  } catch {
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }).trim();
}
