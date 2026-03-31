// Git and GitHub CLI operations for worktree-based workers.
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

export function getBranchPR(
  repoPath: string,
  branchName: string,
): number | null {
  try {
    const result = gh(
      repoPath,
      "pr",
      "list",
      "--head",
      branchName,
      "--json",
      "number",
      "--limit",
      "1",
    );
    const prs = JSON.parse(result);
    if (Array.isArray(prs) && prs.length > 0) {
      return prs[0].number;
    }
    return null;
  } catch {
    return null;
  }
}

export function isPRMerged(repoPath: string, prNumber: number): boolean {
  try {
    const result = gh(
      repoPath,
      "pr",
      "view",
      String(prNumber),
      "--json",
      "state",
    );
    const data = JSON.parse(result);
    return data.state === "MERGED";
  } catch {
    return false;
  }
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

export function forcePushBranch(worktreePath: string): void {
  git(worktreePath, "push", "--force-with-lease");
}

export function mergePR(repoPath: string, prNumber: number): void {
  gh(repoPath, "pr", "merge", String(prNumber), "--merge");
}

export interface PRInfo {
  state: string;
  headSha: string;
}

export function getPRInfo(
  repoPath: string,
  prNumber: number,
): PRInfo | null {
  try {
    const result = gh(
      repoPath,
      "pr",
      "view",
      String(prNumber),
      "--json",
      "state,headRefOid",
    );
    const data = JSON.parse(result);
    return {
      state: data.state,
      headSha: data.headRefOid,
    };
  } catch {
    return null;
  }
}

export function commentOnPR(
  repoPath: string,
  prNumber: number,
  body: string,
): void {
  try {
    gh(repoPath, "pr", "comment", String(prNumber), "--body", body);
  } catch {
    // best effort — don't block the poller if commenting fails
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

export function getPRDetails(
  repoPath: string,
  prNumber: number,
): { title: string; url: string } | null {
  try {
    const result = gh(
      repoPath,
      "pr",
      "view",
      String(prNumber),
      "--json",
      "title,url",
    );
    const data = JSON.parse(result);
    return { title: data.title, url: data.url };
  } catch {
    return null;
  }
}

export function getPRDiff(repoPath: string, prNumber: number): string {
  return gh(repoPath, "pr", "diff", String(prNumber));
}

export function submitPRReview(
  repoPath: string,
  prNumber: number,
  approve: boolean,
  body: string,
): boolean {
  const flag = approve ? "--approve" : "--request-changes";
  try {
    gh(repoPath, "pr", "review", String(prNumber), flag, "--body", body);
    return true;
  } catch (err) {
    log.warn("git", "formal PR review submission failed", {
      prNumber,
      approve,
      error: String(err),
    });
    return false;
  }
}

export function createPR(
  repoPath: string,
  branchName: string,
  title: string,
  body: string,
): number | null {
  try {
    const url = gh(
      repoPath,
      "pr", "create",
      "--head", branchName,
      "--title", title,
      "--body", body,
    ).trim();
    const match = url.match(/\/pull\/(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  } catch (err) {
    log.warn("git", "failed to create PR", {
      branchName,
      error: String(err),
    });
    return null;
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

export function pruneWorktrees(repoPath: string): void {
  try {
    git(repoPath, "worktree", "prune");
  } catch {
    // best effort
  }
}

export function installClaudeHook(wtPath: string): void {
  const claudeDir = path.join(wtPath, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const signalFifo = path.join(SESSIONS_DIR, "poll-signal");

  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `grep -q 'gh pr create' && (echo > '${signalFifo}') >/dev/null 2>&1 & exit 0`,
            },
          ],
        },
      ],
    },
  };

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  log.info("git", "installed Claude hook for PR detection", { wtPath });
}

export function installPollTriggerHook(wtPath: string): void {
  const hooksDir = path.join(wtPath, ".garden-hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const signalFifo = path.join(SESSIONS_DIR, "poll-signal");
  const hookScript = [
    "#!/bin/sh",
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }).trim();
}

function gh(cwd: string, ...args: string[]): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }).trim();
}
