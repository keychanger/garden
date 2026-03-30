// Git and GitHub CLI operations for worktree-based workers.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { log } from "./log.js";

const WORKTREE_BASE = path.join(
  process.env.HOME ?? "",
  ".garden",
  "worktrees",
);

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

export function getPRReviewDecision(
  repoPath: string,
  prNumber: number,
): string | null {
  try {
    const result = gh(
      repoPath,
      "pr",
      "view",
      String(prNumber),
      "--json",
      "reviewDecision",
    );
    const data = JSON.parse(result);
    return data.reviewDecision ?? null;
  } catch {
    return null;
  }
}

export function getPRReviewFeedback(
  repoPath: string,
  prNumber: number,
): string {
  try {
    const result = gh(
      repoPath,
      "pr",
      "view",
      String(prNumber),
      "--json",
      "reviews",
    );
    const data = JSON.parse(result);
    if (!Array.isArray(data.reviews) || data.reviews.length === 0) return "";
    const latest = data.reviews[data.reviews.length - 1];
    return latest.body ?? "";
  } catch {
    return "";
  }
}

export function rebaseBranch(worktreePath: string): boolean {
  try {
    git(worktreePath, "rebase", "main");
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
  gh(repoPath, "pr", "merge", String(prNumber), "--squash", "--delete-branch");
}

export interface PRInfo {
  state: string;
  isDraft: boolean;
  headSha: string;
  reviewDecision: string | null;
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
      "state,isDraft,headRefOid,reviewDecision",
    );
    const data = JSON.parse(result);
    return {
      state: data.state,
      isDraft: data.isDraft,
      headSha: data.headRefOid,
      reviewDecision: data.reviewDecision ?? null,
    };
  } catch {
    return null;
  }
}

export function convertToDraft(repoPath: string, prNumber: number): void {
  gh(repoPath, "pr", "ready", String(prNumber), "--undo");
}

export function markReady(repoPath: string, prNumber: number): void {
  gh(repoPath, "pr", "ready", String(prNumber));
}

export interface ReviewInfo {
  id: string;
  body: string;
  state: string;
}

export function getLatestReview(
  repoPath: string,
  prNumber: number,
): ReviewInfo | null {
  try {
    const result = gh(
      repoPath,
      "pr",
      "view",
      String(prNumber),
      "--json",
      "reviews",
    );
    const data = JSON.parse(result);
    if (!Array.isArray(data.reviews) || data.reviews.length === 0) return null;
    for (let i = data.reviews.length - 1; i >= 0; i--) {
      const r = data.reviews[i];
      if (r.body) {
        return { id: r.id, body: r.body, state: r.state };
      }
    }
    return null;
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

export function pruneWorktrees(repoPath: string): void {
  try {
    git(repoPath, "worktree", "prune");
  } catch {
    // best effort
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gh(cwd: string, ...args: string[]): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
