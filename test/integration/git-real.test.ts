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
