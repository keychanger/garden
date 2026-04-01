// Git operations for worktree-based workers.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { SESSIONS_DIR } from "../config.js";
import { log } from "./log.js";

const WORKTREE_BASE = path.join(
  process.env.HOME ?? "",
  ".garden",
  "worktrees",
);

export function worktreePath(project: string, workerName: string): string {
  return path.join(WORKTREE_BASE, project, workerName);
}

export function fastForwardMain(repoPath: string): void {
  try {
    git(repoPath, "fetch", "origin", "main");
    git(repoPath, "merge", "--ff-only", "origin/main");
    log.info("git", "fast-forwarded main", { repoPath });
  } catch (err) {
    log.warn("git", "failed to fast-forward main", {
      repoPath,
      error: String(err),
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
  log.info("git", "created worktree", { wtPath, branchName });
  installDeps(wtPath);
}

export function removeWorktree(repoPath: string, wtPath: string): void {
  try {
    git(repoPath, "worktree", "remove", wtPath, "--force");
    log.info("git", "removed worktree", { wtPath });
  } catch (err) {
    log.warn("git", "failed to remove worktree", {
      wtPath,
      error: String(err),
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
    log.info("git", "deleted branch", { branchName });
  } catch (err) {
    log.warn("git", "failed to delete branch", {
      branchName,
      error: String(err),
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

export function getDiffAgainstMain(wtPath: string): string {
  return git(wtPath, "diff", "origin/main...HEAD");
}

export function rebaseBranch(worktreePath: string): boolean {
  try {
    git(worktreePath, "rebase", "origin/main");
    return true;
  } catch {
    return false;
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
  git(worktreePath, "push", "--force-with-lease", "origin", branch);
}

export function mergeToMain(repoPath: string, branchName: string): void {
  git(repoPath, "fetch", "origin");
  git(repoPath, "checkout", "main");
  git(repoPath, "merge", "--ff-only", `origin/${branchName}`);
  git(repoPath, "push", "origin", "main");
  log.info("git", "merged to main", { branchName });
}

export function deleteRemoteBranch(repoPath: string, branchName: string): void {
  try {
    git(repoPath, "push", "origin", "--delete", branchName);
    log.info("git", "deleted remote branch", { branchName });
  } catch (err) {
    log.warn("git", "failed to delete remote branch", {
      branchName,
      error: String(err),
    });
  }
}

export function getChangedFiles(wtPath: string): string[] {
  try {
    const result = git(wtPath, "diff", "--name-only", "origin/main...HEAD");
    return result.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function getCommitSummary(wtPath: string): string {
  try {
    return execFileSync("git", [
      "log", "--oneline", "origin/main..HEAD",
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

export function installPollTriggerHook(wtPath: string, _gardenRunner?: string): void {
  const hooksDir = path.join(wtPath, ".garden-hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const signalFifo = path.join(SESSIONS_DIR, "poll-signal");

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
  log.info("git", "installed poll trigger hook", { wtPath });
}

function installDeps(wtPath: string): void {
  if (!fs.existsSync(path.join(wtPath, "package.json"))) return;
  try {
    execFileSync("npm", ["install"], {
      cwd: wtPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    log.info("git", "installed dependencies", { wtPath });
  } catch (err) {
    log.warn("git", "failed to install dependencies", {
      wtPath,
      error: String(err),
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
