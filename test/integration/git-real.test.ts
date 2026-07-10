import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let originPath: string;

beforeEach(() => {
  originPath = path.join(env.home, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath], { stdio: "ignore" });
  git(env.repoPath, "remote", "add", "origin", originPath);
  git(env.repoPath, "push", "origin", "main");
});

describe("createWorktree (real git)", () => {
  it("creates a worktree at the requested path on a new branch", async () => {
    const { createWorktree, worktreeExists, currentBranch } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "alpha");
    createWorktree(env.repoPath, wt, "alpha-branch");
    expect(worktreeExists(wt)).toBe(true);
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
    expect(currentBranch(wt)).toBe("alpha-branch");
  });

  it("createWorktree fails clearly when branch already exists", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    git(env.repoPath, "branch", "preexisting");
    const wt = path.join(env.home, "wt", "dup");
    expect(() =>
      createWorktree(env.repoPath, wt, "preexisting"),
    ).toThrow();
  });
});

describe("removeWorktree (real git)", () => {
  it("removes the worktree from disk and prunes git state", async () => {
    const { createWorktree, removeWorktree, worktreeExists } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "ephemeral");
    createWorktree(env.repoPath, wt, "ephemeral-branch");
    expect(worktreeExists(wt)).toBe(true);
    removeWorktree(env.repoPath, wt);
    expect(worktreeExists(wt)).toBe(false);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("does not throw when the worktree path is already gone", async () => {
    const { removeWorktree } = await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "never-existed");
    expect(() => removeWorktree(env.repoPath, wt)).not.toThrow();
  });
});

describe("getDiffAgainstBase (real git)", () => {
  it("returns the diff for new commits ahead of origin/main", async () => {
    const { createWorktree, getDiffAgainstBase } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "diff");
    createWorktree(env.repoPath, wt, "diff-branch");
    fs.writeFileSync(path.join(wt, "added.txt"), "hello\n");
    git(wt, "add", "added.txt");
    git(wt, "commit", "-m", "add file");
    const diff = getDiffAgainstBase(wt, "main");
    expect(diff).toContain("added.txt");
    expect(diff).toContain("+hello");
  });

  it("returns empty string when no commits are ahead of origin/main", async () => {
    const { createWorktree, getDiffAgainstBase } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "nodiff");
    createWorktree(env.repoPath, wt, "nodiff-branch");
    expect(getDiffAgainstBase(wt, "main")).toBe("");
  });
});

describe("getBranchHeadSha (real git)", () => {
  it("returns the HEAD sha of the worktree", async () => {
    const { createWorktree, getBranchHeadSha } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "sha");
    createWorktree(env.repoPath, wt, "sha-branch");
    const sha = getBranchHeadSha(wt);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for a path that is not a git worktree", async () => {
    const { getBranchHeadSha } = await import("../../src/dashboard/git.js");
    expect(getBranchHeadSha(path.join(env.home, "not-a-repo"))).toBeNull();
  });
});

describe("rebaseBranch (real git)", () => {
  it("returns ok for a clean fast-forward rebase", async () => {
    const { createWorktree, rebaseBranch } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "ff");
    createWorktree(env.repoPath, wt, "ff-branch");
    fs.writeFileSync(path.join(env.repoPath, "main-only.txt"), "main\n");
    git(env.repoPath, "add", "main-only.txt");
    git(env.repoPath, "commit", "-m", "main advance");
    git(env.repoPath, "push", "origin", "main");
    git(wt, "fetch", "origin");
    const result = rebaseBranch(wt, "main");
    expect(result.kind).toBe("ok");
  });

  it("returns conflict when the rebase has a real conflict", async () => {
    const { createWorktree, rebaseBranch } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "conflict");
    createWorktree(env.repoPath, wt, "conflict-branch");
    fs.writeFileSync(path.join(wt, "shared.txt"), "branch\n");
    git(wt, "add", "shared.txt");
    git(wt, "commit", "-m", "branch change");
    fs.writeFileSync(path.join(env.repoPath, "shared.txt"), "main\n");
    git(env.repoPath, "add", "shared.txt");
    git(env.repoPath, "commit", "-m", "main change");
    git(env.repoPath, "push", "origin", "main");
    git(wt, "fetch", "origin");
    const result = rebaseBranch(wt, "main");
    expect(result.kind).toBe("conflict");
  });
});

describe("currentBranch (real git)", () => {
  it("returns the active branch name in the repo", async () => {
    const { currentBranch } = await import("../../src/dashboard/git.js");
    expect(currentBranch(env.repoPath)).toBe("main");
  });

  it("returns null when path is not a git checkout", async () => {
    const { currentBranch } = await import("../../src/dashboard/git.js");
    expect(currentBranch(path.join(env.home, "not-a-repo"))).toBeNull();
  });
});

describe("currentBranchFast (real git)", () => {
  it("reads the active branch straight from .git/HEAD", async () => {
    const { currentBranchFast } = await import("../../src/dashboard/git.js");
    expect(currentBranchFast(env.repoPath)).toBe("main");
  });

  it("follows the linked-worktree gitdir indirection (.git is a file)", async () => {
    const { createWorktree, currentBranchFast } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "fast");
    createWorktree(env.repoPath, wt, "fast-branch");
    // A linked worktree's .git is a "gitdir: <path>" pointer file, not a dir.
    expect(fs.statSync(path.join(wt, ".git")).isFile()).toBe(true);
    expect(currentBranchFast(wt)).toBe("fast-branch");
  });

  it("returns a slash-bearing branch name in full, matching the git fork", async () => {
    const { currentBranchFast, currentBranch } =
      await import("../../src/dashboard/git.js");
    git(env.repoPath, "checkout", "-b", "release/2.0");
    // HEAD is `ref: refs/heads/release/2.0`; the `.+` capture must keep the
    // slash rather than stop at the first path segment, so the displayed value
    // stays identical to `git rev-parse --abbrev-ref HEAD`.
    expect(currentBranchFast(env.repoPath)).toBe("release/2.0");
    expect(currentBranchFast(env.repoPath)).toBe(currentBranch(env.repoPath));
  });

  it("falls back to the git fork on a detached HEAD", async () => {
    const { currentBranchFast } = await import("../../src/dashboard/git.js");
    const sha = git(env.repoPath, "rev-parse", "HEAD");
    git(env.repoPath, "checkout", "--detach", sha);
    // No `ref:` line in HEAD, so the fast path defers to currentBranch. That
    // returns git rev-parse's literal "HEAD" for a detached head — the point is
    // the displayed value matches the fork, not that it's meaningful.
    expect(currentBranchFast(env.repoPath)).toBe("HEAD");
  });

  it("falls back to null when path is not a git checkout", async () => {
    const { currentBranchFast } = await import("../../src/dashboard/git.js");
    expect(currentBranchFast(path.join(env.home, "not-a-repo"))).toBeNull();
  });
});

describe("deleteBranch (real git)", () => {
  it("deletes a local branch", async () => {
    const { deleteBranch } = await import("../../src/dashboard/git.js");
    git(env.repoPath, "branch", "to-delete");
    expect(git(env.repoPath, "branch", "--list", "to-delete")).toContain("to-delete");
    deleteBranch(env.repoPath, "to-delete");
    expect(git(env.repoPath, "branch", "--list", "to-delete")).toBe("");
  });

  it("is a no-op for a missing branch", async () => {
    const { deleteBranch } = await import("../../src/dashboard/git.js");
    expect(() => deleteBranch(env.repoPath, "ghost")).not.toThrow();
  });
});

// Regression: wolf's main absorbed a committed `.garden-done` on 2026-05-06.
// newWorker now consults this helper to raise a dashboard alert at spawn
// time; the bootstrap script template runs the same git ls-tree check in
// bash to defang each new worktree. Cover both the affirmative and negative
// cases against a real repo so the detection stays honest across git
// version differences.
describe("gardenDoneTrackedInHead (real git)", () => {
  it("returns true when .garden-done is tracked in HEAD", async () => {
    const { gardenDoneTrackedInHead } = await import("../../src/dashboard/git.js");
    fs.writeFileSync(path.join(env.repoPath, ".garden-done"), "");
    git(env.repoPath, "add", ".garden-done");
    git(env.repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "accidental sentinel");
    expect(gardenDoneTrackedInHead(env.repoPath)).toBe(true);
  });

  it("returns false when .garden-done is not tracked", async () => {
    const { gardenDoneTrackedInHead } = await import("../../src/dashboard/git.js");
    expect(gardenDoneTrackedInHead(env.repoPath)).toBe(false);
  });

  it("returns false when an untracked .garden-done exists on disk", async () => {
    const { gardenDoneTrackedInHead } = await import("../../src/dashboard/git.js");
    // The helper checks HEAD, not the working tree — a worker that wrote
    // the sentinel via the `done` skill must NOT trip a fresh-project alert.
    fs.writeFileSync(path.join(env.repoPath, ".garden-done"), "");
    expect(gardenDoneTrackedInHead(env.repoPath)).toBe(false);
  });
});

// Regression: ⌥n on a local-only branch used to refuse the worker with a
// generic remediation hint. tryPublishBranch is the auto-publish gesture
// workers.ts now runs first — push the branch to origin so the worker can
// branch off it like any other base.
describe("tryPublishBranch (real git)", () => {
  it("publishes a local-only branch to origin and creates the remotes ref", async () => {
    const { tryPublishBranch, branchExistsOnOrigin } =
      await import("../../src/dashboard/git.js");
    git(env.repoPath, "checkout", "-b", "feature-local");
    expect(branchExistsOnOrigin(env.repoPath, "feature-local")).toBe(false);
    const result = tryPublishBranch(env.repoPath, "feature-local");
    expect(result).toEqual({ ok: true });
    // The push side-effects refs/remotes/origin/feature-local; downstream
    // checks (workers.ts, bootstrap, merge) all rely on that ref existing.
    expect(branchExistsOnOrigin(env.repoPath, "feature-local")).toBe(true);
  });

  it("returns ok when the branch is already up to date on origin", async () => {
    const { tryPublishBranch } = await import("../../src/dashboard/git.js");
    git(env.repoPath, "checkout", "-b", "already-pushed");
    git(env.repoPath, "push", "-u", "origin", "already-pushed");
    const result = tryPublishBranch(env.repoPath, "already-pushed");
    expect(result).toEqual({ ok: true });
  });

  it("returns error with captured stderr when origin remote is missing", async () => {
    const { tryPublishBranch } = await import("../../src/dashboard/git.js");
    git(env.repoPath, "remote", "remove", "origin");
    git(env.repoPath, "checkout", "-b", "orphan-branch");
    const result = tryPublishBranch(env.repoPath, "orphan-branch");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Don't pin the exact message — git wording differs across versions.
      // The presence of the branch name or "origin" in stderr is enough to
      // prove we captured something actionable.
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error.toLowerCase()).toMatch(/origin|remote/);
    }
  });
});
