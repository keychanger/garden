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

describe("getDiffNumstat (real git)", () => {
  it("totals files, insertions, and deletions across a SHA range", async () => {
    const { createWorktree, getBranchHeadSha, getDiffNumstat } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "numstat");
    createWorktree(env.repoPath, wt, "numstat-branch");
    const from = getBranchHeadSha(wt)!;
    fs.writeFileSync(path.join(wt, "a.txt"), "l1\nl2\nl3\n");
    fs.writeFileSync(path.join(wt, "b.txt"), "x\n");
    git(wt, "add", "a.txt", "b.txt");
    git(wt, "commit", "-m", "two files");
    const to = getBranchHeadSha(wt)!;

    const stat = getDiffNumstat(wt, from, to);
    expect(stat.files).toBe(2);
    expect(stat.insertions).toBe(4); // 3 + 1
    expect(stat.deletions).toBe(0);
  });

  it("returns all-zero on a no-op range (a CLEAN review)", async () => {
    const { createWorktree, getBranchHeadSha, getDiffNumstat } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "numstat-clean");
    createWorktree(env.repoPath, wt, "numstat-clean-branch");
    const sha = getBranchHeadSha(wt)!;
    expect(getDiffNumstat(wt, sha, sha)).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("returns all-zero on a git failure (unknown SHA)", async () => {
    const { createWorktree, getDiffNumstat } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "numstat-bad");
    createWorktree(env.repoPath, wt, "numstat-bad-branch");
    expect(getDiffNumstat(wt, "deadbeef", "cafebabe")).toEqual({
      files: 0, insertions: 0, deletions: 0,
    });
  });

  it("counts a binary file as one touched file with zero line deltas", async () => {
    const { createWorktree, getBranchHeadSha, getDiffNumstat } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "numstat-binary");
    createWorktree(env.repoPath, wt, "numstat-binary-branch");
    const from = getBranchHeadSha(wt)!;
    // A NUL byte makes git classify the file as binary, so `git diff --numstat`
    // emits "-\t-\t<path>" for it. The DiffNumstat contract counts it as a
    // touched file whose parseInt("-") -> NaN adds nothing to the line totals.
    fs.writeFileSync(path.join(wt, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    git(wt, "add", "blob.bin");
    git(wt, "commit", "-m", "add a binary blob");
    const to = getBranchHeadSha(wt)!;

    const stat = getDiffNumstat(wt, from, to);
    expect(stat.files).toBe(1);
    expect(stat.insertions).toBe(0);
    expect(stat.deletions).toBe(0);
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

  // The lex/lost-light-pulse failure, 2026-08-12: a worker legitimately merged
  // a sibling branch into its own, leaving the base tip as the merge commit's
  // first parent. The branch was a pure fast-forward of the base, but plain
  // `git rebase` flattened the merge and replayed the sibling's commits against
  // a tree that already had them — an unwinnable conflict that burned the whole
  // resolver budget.
  it("skips the rebase when the branch merged a sibling on top of the base tip", async () => {
    const { createWorktree, rebaseBranch } =
      await import("../../src/dashboard/git.js");
    git(env.repoPath, "checkout", "-b", "sibling");
    fs.writeFileSync(path.join(env.repoPath, "sibling.txt"), "sibling\n");
    git(env.repoPath, "add", "sibling.txt");
    git(env.repoPath, "commit", "-m", "sibling work");
    git(env.repoPath, "checkout", "main");

    const wt = path.join(env.home, "wt", "merged");
    createWorktree(env.repoPath, wt, "merged-branch");
    fs.writeFileSync(path.join(wt, "worker.txt"), "worker\n");
    git(wt, "add", "worker.txt");
    git(wt, "commit", "-m", "worker work");
    git(wt, "merge", "--no-ff", "sibling", "-m", "merge sibling");
    git(wt, "fetch", "origin");
    const mergeSha = git(wt, "rev-parse", "HEAD");

    const result = rebaseBranch(wt, "main");

    expect(result.kind).toBe("up-to-date");
    // HEAD untouched: still the merge commit, still with the base tip reachable
    // as its first parent.
    expect(git(wt, "rev-parse", "HEAD")).toBe(mergeSha);
    expect(git(wt, "rev-list", "--merges", "origin/main..HEAD")).toBe(mergeSha);
  });

  it("preserves the merge commit when the base advanced and a rebase is required", async () => {
    const { createWorktree, rebaseBranch } =
      await import("../../src/dashboard/git.js");
    git(env.repoPath, "checkout", "-b", "sibling");
    fs.writeFileSync(path.join(env.repoPath, "sibling.txt"), "sibling\n");
    git(env.repoPath, "add", "sibling.txt");
    git(env.repoPath, "commit", "-m", "sibling work");
    git(env.repoPath, "checkout", "main");

    const wt = path.join(env.home, "wt", "merged-behind");
    createWorktree(env.repoPath, wt, "merged-behind-branch");
    fs.writeFileSync(path.join(wt, "worker.txt"), "worker\n");
    git(wt, "add", "worker.txt");
    git(wt, "commit", "-m", "worker work");
    git(wt, "merge", "--no-ff", "sibling", "-m", "merge sibling");

    // Base advances after the merge, so the branch genuinely has to be replayed.
    fs.writeFileSync(path.join(env.repoPath, "main-only.txt"), "main\n");
    git(env.repoPath, "add", "main-only.txt");
    git(env.repoPath, "commit", "-m", "main advance");
    git(env.repoPath, "push", "origin", "main");
    git(wt, "fetch", "origin");

    const result = rebaseBranch(wt, "main");

    expect(result.kind).toBe("ok");
    // The branch now sits on the advanced base...
    expect(git(wt, "rev-list", "--count", "HEAD..origin/main")).toBe("0");
    // ...and the merge survived the replay rather than being flattened away.
    expect(git(wt, "rev-list", "--merges", "origin/main..HEAD")).not.toBe("");
    expect(git(wt, "log", "--format=%s", "origin/main..HEAD")).toContain("merge sibling");
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

describe("listBranches (real git)", () => {
  it("de-dupes local + origin branches, strips origin/, drops HEAD, and caps", async () => {
    const { listBranches } = await import("../../src/dashboard/git.js");
    // origin already has main (beforeEach pushes it). feature-a lives both
    // locally and on origin (must collapse to one); local-only is local-only.
    git(env.repoPath, "checkout", "-b", "feature-a");
    fs.writeFileSync(path.join(env.repoPath, "a.txt"), "a");
    git(env.repoPath, "add", "a.txt");
    git(env.repoPath, "commit", "-m", "feature a");
    git(env.repoPath, "push", "origin", "feature-a");
    git(env.repoPath, "checkout", "-b", "local-only");
    git(env.repoPath, "fetch", "origin");
    git(env.repoPath, "remote", "set-head", "origin", "main"); // creates refs/remotes/origin/HEAD

    const branches = listBranches(env.repoPath);
    expect(new Set(branches)).toEqual(new Set(["main", "feature-a", "local-only"]));
    expect(branches.filter((b) => b === "feature-a")).toHaveLength(1); // de-duped local+origin
    expect(branches.some((b) => b.startsWith("origin/"))).toBe(false); // prefix stripped
    expect(branches).not.toContain("HEAD"); // origin/HEAD sentinel dropped
    expect(branches).not.toContain("origin");
    expect(listBranches(env.repoPath, 2)).toHaveLength(2); // cap honored
  });

  it("excludes worker-named branches from the list", async () => {
    const { listBranches } = await import("../../src/dashboard/git.js");
    // Worker branches (generated adjective-adjective-noun names) are never
    // sensible base/build targets — the pickers must not offer them. A
    // local-only one covers stale branches whose worker is long removed.
    git(env.repoPath, "checkout", "-b", "rich-wee-bay");
    fs.writeFileSync(path.join(env.repoPath, "w.txt"), "w");
    git(env.repoPath, "add", "w.txt");
    git(env.repoPath, "commit", "-m", "worker work");
    git(env.repoPath, "push", "origin", "rich-wee-bay");
    git(env.repoPath, "checkout", "-b", "bold-keen-ash");
    git(env.repoPath, "checkout", "main");

    const branches = listBranches(env.repoPath);
    expect(branches).toContain("main");
    expect(branches).not.toContain("rich-wee-bay");
    expect(branches).not.toContain("bold-keen-ash");
  });

  it("returns [] on a path that is not a git repo (best-effort)", async () => {
    const { listBranches } = await import("../../src/dashboard/git.js");
    expect(listBranches(path.join(env.home, "not-a-repo"))).toEqual([]);
  });
});

describe("scopeHooksPathToWorktree / installPollTriggerHook (real git)", () => {
  it("scopes hooksPath to the worktree without leaking into shared config", async () => {
    const { createWorktree, scopeHooksPathToWorktree } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "scoped");
    createWorktree(env.repoPath, wt, "scoped-branch");
    const hooksDir = path.join(wt, ".garden-hooks");

    scopeHooksPathToWorktree(wt, hooksDir);

    // Applies to the worktree...
    expect(git(wt, "config", "--worktree", "--get", "core.hooksPath")).toBe(hooksDir);
    // ...but NOT to the shared config (the leak this fix exists to prevent):
    // the main checkout must fall back to its own .git/hooks.
    const sharedGet = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: env.repoPath, encoding: "utf8",
    });
    expect(sharedGet.status).not.toBe(0); // unset in shared config
    // Unset in EVERY scope the main checkout resolves, not just --local, so a
    // leak through any other scope would still fail this.
    const effective = spawnSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: env.repoPath, encoding: "utf8",
    });
    expect(effective.status).not.toBe(0);
  });

  it("migrates a garden-owned leak already in the shared config", async () => {
    const { createWorktree, scopeHooksPathToWorktree } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "leaked");
    createWorktree(env.repoPath, wt, "leaked-branch");
    // Simulate the old --local leak from a prior worker.
    git(env.repoPath, "config", "--local", "core.hooksPath", "/somewhere/.garden-hooks");
    expect(git(env.repoPath, "config", "--get", "core.hooksPath")).toBe("/somewhere/.garden-hooks");

    scopeHooksPathToWorktree(wt, path.join(wt, ".garden-hooks"));

    const sharedGet = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: env.repoPath, encoding: "utf8",
    });
    expect(sharedGet.status).not.toBe(0); // garden leak cleared
  });

  it("preserves an operator's own (non-garden) shared hooksPath", async () => {
    const { createWorktree, scopeHooksPathToWorktree } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "operator");
    createWorktree(env.repoPath, wt, "operator-branch");
    git(env.repoPath, "config", "--local", "core.hooksPath", "/opt/company/githooks");

    scopeHooksPathToWorktree(wt, path.join(wt, ".garden-hooks"));

    // The operator's deliberate repo-wide hooksPath is left alone.
    expect(git(env.repoPath, "config", "--local", "--get", "core.hooksPath")).toBe("/opt/company/githooks");
    // ...and the worker still gets its own hooks: worktree scope outranks the
    // preserved --local value, so preserving it can't silently disable the
    // poll-trigger hook. Without this, a future "bail out when an operator
    // value exists" shortcut would keep the assertion above green while the
    // worker's pre-push signal stopped firing.
    expect(git(wt, "config", "--get", "core.hooksPath")).toBe(path.join(wt, ".garden-hooks"));
  });

  it("installPollTriggerHook writes the pre-push hook and scopes it per worktree", async () => {
    const { createWorktree, installPollTriggerHook } =
      await import("../../src/dashboard/git.js");
    const wt = path.join(env.home, "wt", "poll");
    createWorktree(env.repoPath, wt, "poll-branch");

    installPollTriggerHook(wt, "garden", "myproject");

    const hookPath = path.join(wt, ".garden-hooks", "pre-push");
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(git(wt, "config", "--worktree", "--get", "core.hooksPath")).toBe(path.join(wt, ".garden-hooks"));
    const sharedGet = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: env.repoPath, encoding: "utf8",
    });
    expect(sharedGet.status).not.toBe(0);
  });
});

// The trap this guards against: postMerge (`npm install && npm run build`)
// rewrites a tracked file in the operator's base checkout, the resulting dirty
// tree makes the NEXT merge's `merge --ff-only` refuse, and the refusal skips
// postMerge — so one hook run can freeze the checkout, and the binary built
// from it, indefinitely.
describe("postMerge churn revert (real git)", () => {
  it("reverts a tracked file the hook dirtied", async () => {
    const { listModifiedTrackedFiles, revertChurn } = await import("../../src/dashboard/git.js");
    const before = new Set(listModifiedTrackedFiles(env.repoPath));
    // Stand in for `npm install` rewriting package-lock.json.
    fs.writeFileSync(path.join(env.repoPath, "README.md"), "churned by the hook\n");
    expect(listModifiedTrackedFiles(env.repoPath)).toContain("README.md");

    expect(revertChurn(env.repoPath, before)).toEqual(["README.md"]);
    expect(listModifiedTrackedFiles(env.repoPath)).toEqual([]);
  });

  it("leaves an operator edit that predates the hook strictly alone", async () => {
    const { listModifiedTrackedFiles, revertChurn } = await import("../../src/dashboard/git.js");
    fs.writeFileSync(path.join(env.repoPath, "README.md"), "operator work in progress\n");
    const before = new Set(listModifiedTrackedFiles(env.repoPath));

    expect(revertChurn(env.repoPath, before)).toEqual([]);
    expect(fs.readFileSync(path.join(env.repoPath, "README.md"), "utf8"))
      .toBe("operator work in progress\n");
  });

  it("never touches untracked files", async () => {
    const { listModifiedTrackedFiles, revertChurn } = await import("../../src/dashboard/git.js");
    const before = new Set(listModifiedTrackedFiles(env.repoPath));
    const stray = path.join(env.repoPath, "build-output.txt");
    fs.writeFileSync(stray, "generated\n");

    expect(revertChurn(env.repoPath, before)).toEqual([]);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it("a reverted checkout fast-forwards again — the trap does not re-arm", async () => {
    const { listModifiedTrackedFiles, revertChurn, fastForwardBase } =
      await import("../../src/dashboard/git.js");
    // Advance origin/main with a commit that touches the SAME file the hook
    // churns. The collision is what arms the trap: `merge --ff-only` tolerates
    // a dirty file the merge does not touch, and refuses only when the incoming
    // commits would overwrite it. That is the real shape — a lockfile churned
    // by `npm install`, then a merged dependency bump touching that lockfile.
    const other = path.join(env.home, "clone");
    git(env.home, "clone", originPath, other);
    fs.writeFileSync(path.join(other, "README.md"), "landed upstream\n");
    git(other, "add", "-A");
    git(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "land");
    git(other, "push", "origin", "main");

    // The hook dirties the base checkout; without the revert this ff refuses.
    const before = new Set(listModifiedTrackedFiles(env.repoPath));
    fs.writeFileSync(path.join(env.repoPath, "README.md"), "churned\n");
    expect(fastForwardBase(env.repoPath, "main").ok).toBe(false);

    revertChurn(env.repoPath, before);
    const result = fastForwardBase(env.repoPath, "main");
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(env.repoPath, "README.md"), "utf8"))
      .toBe("landed upstream\n");
  });

  // The `behind` count on the dirty result is what the operator alert turns
  // into "N commits behind origin/main" — the signal that separates a
  // one-merge blip from a checkout frozen for a dozen merges. The poller test
  // proves the wording given a number; only this proves the number is real.
  it("reports how far a dirty checkout has fallen behind origin", async () => {
    const { fastForwardBase } = await import("../../src/dashboard/git.js");
    const other = path.join(env.home, "drift-clone");
    git(env.home, "clone", originPath, other);
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(other, "README.md"), `upstream ${n}\n`);
      git(other, "add", "-A");
      git(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `up${n}`);
    }
    git(other, "push", "origin", "main");

    // Dirty the same file the incoming commits touch, so ff-only refuses.
    fs.writeFileSync(path.join(env.repoPath, "README.md"), "churned\n");
    const result = fastForwardBase(env.repoPath, "main");

    expect(result).toMatchObject({ ok: false, reason: "dirty", behind: 3 });
  });

  it("reports behind: 0 for a dirty checkout that is level with origin", async () => {
    const { fastForwardBase } = await import("../../src/dashboard/git.js");
    // No upstream movement: ff-only is a no-op, so the checkout advances even
    // though it is dirty. The drift clause must not fire on this shape.
    fs.writeFileSync(path.join(env.repoPath, "README.md"), "churned\n");
    const result = fastForwardBase(env.repoPath, "main");
    if (!result.ok && result.reason === "dirty") expect(result.behind).toBe(0);
    else expect(result.ok).toBe(true);
  });
});

// Feeds the status-bar staleness indicator: how far the running build's commit
// trails the branch it is compared against.
describe("commitsBehindOrigin (real git)", () => {
  it("counts commits the build's ref trails origin/<branch> by", async () => {
    const { commitsBehindOrigin, getBranchHeadSha } = await import("../../src/dashboard/git.js");
    const built = getBranchHeadSha(env.repoPath)!;
    expect(commitsBehindOrigin(env.repoPath, built, "main")).toBe(0);

    // Land two commits upstream without moving the local checkout.
    const other = path.join(env.home, "behind-clone");
    git(env.home, "clone", originPath, other);
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(other, `c${n}.txt`), `${n}\n`);
      git(other, "add", "-A");
      git(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `c${n}`);
    }
    git(other, "push", "origin", "main");
    // The local origin/main ref only moves on fetch — deliberately no network
    // call at render time, so the count reflects the last fetch.
    expect(commitsBehindOrigin(env.repoPath, built, "main")).toBe(0);
    git(env.repoPath, "fetch", "origin");
    expect(commitsBehindOrigin(env.repoPath, built, "main")).toBe(2);
  });

  it("returns null rather than 0 for an unknown ref or branch", async () => {
    const { commitsBehindOrigin, getBranchHeadSha } = await import("../../src/dashboard/git.js");
    // null, not 0: an unmeasurable build must leave the bar alone, and 0 would
    // read as "current".
    expect(commitsBehindOrigin(env.repoPath, "deadbeef", "main")).toBeNull();
    expect(commitsBehindOrigin(env.repoPath, getBranchHeadSha(env.repoPath)!, "no-such")).toBeNull();
  });
});

describe("mergeToBase (real git)", () => {
  it("merges despite an operator pre-push guard blocking pushes to main", async () => {
    const { mergeToBase } = await import("../../src/dashboard/git.js");
    git(env.repoPath, "checkout", "-b", "feature");
    fs.writeFileSync(path.join(env.repoPath, "feature.txt"), "work\n");
    git(env.repoPath, "add", "feature.txt");
    git(env.repoPath, "commit", "-m", "feature work");
    git(env.repoPath, "push", "origin", "feature");
    git(env.repoPath, "checkout", "main");

    // An operator guard vetoing any push to refs/heads/main — the shape that
    // silently blocked the merge queue once the hooksPath leak was fixed and
    // the checkout's own .git/hooks came back into effect.
    const hookPath = path.join(env.repoPath, ".git", "hooks", "pre-push");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\nwhile read l ls r rs; do\n  if [ "$r" = "refs/heads/main" ]; then echo "blocked"; exit 1; fi\ndone\nexit 0\n',
      { mode: 0o755 },
    );
    // Prove the guard actually bites, so the assertion below can't pass
    // against a hook that never executed.
    expect(() => git(env.repoPath, "push", "origin", "feature:main")).toThrow();

    const sha = git(env.repoPath, "rev-parse", "origin/feature");
    mergeToBase(env.repoPath, "feature", "main");
    expect(git(originPath, "rev-parse", "main")).toBe(sha);
  });
});
