// Garden's own git runs unsandboxed, as the operator, inside worktrees a worker
// controls. These exercise the real git binary against a worktree laid out the
// way the bootstrap lays one out: core.hooksPath scoped to the worktree's own
// .garden-hooks, a directory the worker can write.
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

let wt: string;
let marker: string;

// A hook that records that it ran, for each name a worker might plant.
function plantHook(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const hook = path.join(dir, name);
  fs.writeFileSync(hook, `#!/bin/sh\necho ${name} >> "${marker}"\n`);
  fs.chmodSync(hook, 0o755);
}

// Commit a file to origin's main from a separate clone, as a sibling merge would.
function advanceOrigin(file: string): void {
  const other = path.join(env.home, "other");
  if (!fs.existsSync(other)) {
    git(env.home, "clone", "-q", path.join(env.home, "origin.git"), other);
    git(other, "config", "user.email", "test@garden.local");
    git(other, "config", "user.name", "garden-test");
  }
  git(other, "pull", "-q", "origin", "main");
  fs.writeFileSync(path.join(other, file), `${file}\n`);
  git(other, "add", file);
  git(other, "commit", "-q", "-m", file);
  git(other, "push", "-q", "origin", "main");
}

function ran(): string[] {
  return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean) : [];
}

beforeEach(() => {
  marker = path.join(env.home, "hooks-ran");
  const origin = path.join(env.home, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  git(env.repoPath, "remote", "add", "origin", origin);
  git(env.repoPath, "push", "origin", "main");
  git(env.repoPath, "fetch", "origin");
  wt = path.join(env.home, ".garden", "worktrees", "repo", "bold-ash");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(env.repoPath, "worktree", "add", wt, "-b", "bold-ash", "origin/main");
  git(wt, "config", "user.email", "test@garden.local");
  git(wt, "config", "user.name", "garden-test");
  git(wt, "config", "extensions.worktreeConfig", "true");
  git(wt, "config", "--worktree", "core.hooksPath", path.join(wt, ".garden-hooks"));
  fs.writeFileSync(path.join(wt, "work.txt"), "work\n");
  git(wt, "add", "work.txt");
  git(wt, "commit", "-m", "work");
});

describe("garden's git in a worker worktree", () => {
  it("does not run hooks the worker planted when the poller pushes, fetches, checks out or rebases", async () => {
    const { forcePushBranch, fetchBaseBranch, cleanWorktree, rebaseBranch } = await import("../../src/dashboard/git.js");
    const hooks = path.join(wt, ".garden-hooks");
    for (const name of ["pre-push", "reference-transaction", "post-checkout", "pre-rebase", "post-rewrite"]) {
      plantHook(hooks, name);
    }
    // The worker's own git, inside its sandbox, would still run them.
    git(wt, "checkout", "--", ".");
    expect(ran()).toContain("post-checkout");
    fs.rmSync(marker);

    // Advance origin from an independent clone, so the fetch below really moves
    // a ref (a push from the main checkout would already have moved the shared
    // remote-tracking ref) and the rebase has work to do.
    advanceOrigin("base.txt");

    forcePushBranch(wt, "bold-ash");
    expect(ran()).toEqual([]);
    fetchBaseBranch(wt, "main");
    expect(ran()).toEqual([]);
    expect(git(wt, "rev-parse", "origin/main")).toBe(git(path.join(env.home, "other"), "rev-parse", "HEAD"));
    fs.writeFileSync(path.join(wt, "work.txt"), "unstaged edit\n");
    cleanWorktree(wt);
    expect(ran()).toEqual([]);
    expect(rebaseBranch(wt, "main")).toEqual({ kind: "ok" });
    expect(ran()).toEqual([]);

    expect(git(env.repoPath, "rev-parse", "origin/bold-ash")).not.toBe("");
    expect(fs.readFileSync(path.join(wt, "work.txt"), "utf8")).toBe("work\n");
  });

  it("does not run an fsmonitor from the worktree's config when checking whether it is dirty", async () => {
    const { isWorktreeDirty } = await import("../../src/dashboard/git.js");
    const fsmonitor = path.join(env.home, "fsmonitor.sh");
    fs.writeFileSync(fsmonitor, `#!/bin/sh\necho fsmonitor >> "${marker}"\nexit 1\n`);
    fs.chmodSync(fsmonitor, 0o755);
    git(wt, "config", "--worktree", "core.fsmonitor", fsmonitor);
    fs.writeFileSync(path.join(wt, "work.txt"), "edit\n");

    expect(isWorktreeDirty(wt)).toBe(true);
    expect(ran()).toEqual([]);
  });

  it("runs no diff driver or textconv program from the worktree's config when building review diffs", async () => {
    const { getDiffAgainstBase, resolveHolisticDiff } = await import("../../src/dashboard/git.js");
    const program = path.join(env.home, "driver.sh");
    fs.writeFileSync(program, `#!/bin/sh\necho driver >> "${marker}"\ncat "$1"\n`);
    fs.chmodSync(program, 0o755);
    git(wt, "config", "--worktree", "diff.external", program);
    git(wt, "config", "--worktree", "diff.planted.textconv", program);
    fs.writeFileSync(path.join(wt, ".gitattributes"), "*.txt diff=planted\n");
    fs.writeFileSync(path.join(wt, "work.txt"), "work, revised\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "revise");
    const base = git(wt, "rev-parse", "origin/main");

    expect(getDiffAgainstBase(wt, "main")).toContain("+work, revised");
    expect(resolveHolisticDiff(wt, base, "HEAD", ["work.txt"])).toContain("+work, revised");
    expect(ran()).toEqual([]);
  });

  it("still runs the operator's own hooks when fast-forwarding the operator's checkout", async () => {
    // board keeps its beads database in sync from post-merge, so garden must
    // not switch hooks off in the operator's own checkout.
    const { fastForwardBase } = await import("../../src/dashboard/git.js");
    plantHook(path.join(env.repoPath, ".git", "hooks"), "post-merge");
    advanceOrigin("merged.txt");

    expect(fastForwardBase(env.repoPath, "main")).toEqual({ ok: true, advanced: "worktree" });
    expect(ran()).toEqual(["post-merge"]);
  });
});

describe("readCommittedFiles", () => {
  it("reads committed regular files and skips symlinks, missing paths and uncommitted edits", async () => {
    const { readCommittedFiles } = await import("../../src/dashboard/git.js");
    fs.mkdirSync(path.join(wt, "test"), { recursive: true });
    // Multibyte content: cat-file frames each blob by its byte length.
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "agents — ⌥ arrows →\n");
    fs.writeFileSync(path.join(wt, "test", "café.test.ts"), "accented é\n");
    fs.symlinkSync("AGENTS.md", path.join(wt, "CLAUDE.md"));
    fs.symlinkSync(path.join(env.home, ".garden", "sessions"), path.join(wt, "DESIGN.md"));
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "docs");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "uncommitted edit\n");

    const files = readCommittedFiles(wt, ["test/café.test.ts", "DESIGN.md", "AGENTS.md", "CLAUDE.md", "missing.md"]);

    expect([...files]).toEqual([["test/café.test.ts", "accented é\n"], ["AGENTS.md", "agents — ⌥ arrows →\n"]]);
  });

  it("reads a name that looks like pathspec magic as that literal path", async () => {
    const { readCommittedFiles } = await import("../../src/dashboard/git.js");
    fs.writeFileSync(path.join(wt, ":(glob)*.md"), "literal\n");
    fs.writeFileSync(path.join(wt, "other.md"), "other\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "odd name");

    expect([...readCommittedFiles(wt, [":(glob)*.md"])]).toEqual([[":(glob)*.md", "literal\n"]]);
  });
});

describe("review prompt inputs", () => {
  it("never follows a symlink the worker committed in place of a doc, test or spec file", async () => {
    const { readDocSections, readTestSections, findSpecFiles } = await import("../../src/dashboard/prompt-compose.js");
    const secret = path.join(env.home, "secret.txt");
    fs.writeFileSync(secret, "OPERATOR-SECRET the code is wrong\n");
    fs.mkdirSync(path.join(wt, "test"), { recursive: true });
    fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
    fs.symlinkSync(secret, path.join(wt, "DESIGN.md"));
    fs.symlinkSync(secret, path.join(wt, "test", "foo.test.ts"));
    fs.symlinkSync(secret, path.join(wt, "docs", "spec.md"));
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# Agents\n\nthe real doc\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "plant");

    const docs = readDocSections(wt).join("\n");
    expect(docs).toContain("the real doc");
    expect(docs).not.toContain("OPERATOR-SECRET");
    expect(readTestSections(wt, ["src/foo.ts"])).toEqual([]);
    expect(findSpecFiles(wt, ["docs/spec.md"])).toEqual([]);
  });
});

describe("what garden hands git", () => {
  it("reads origin's branch by its full name, so a tag or branch named origin/main cannot stand in for it", async () => {
    const { getDiffAgainstBase, getChangedFiles, hasCommitsAhead, countCommitsAheadOfBase, rebaseBranch } =
      await import("../../src/dashboard/git.js");
    // Both shadows sit at the worker's own tip: an abbreviated origin/main
    // would then make the worker's commit vanish from everything below.
    git(wt, "tag", "origin/main", "HEAD");
    git(wt, "branch", "origin/main", "HEAD");

    expect(getDiffAgainstBase(wt, "main")).toContain("+work");
    expect(getChangedFiles(wt, "main")).toEqual(["work.txt"]);
    expect(hasCommitsAhead(wt, "main")).toBe(true);
    expect(countCommitsAheadOfBase(wt, "main")).toBe(1);
    expect(rebaseBranch(wt, "main")).toEqual({ kind: "up-to-date" });
  });

  it("refuses option-shaped SHAs and ranges from the registry without git writing anything", async () => {
    const {
      getNewCommitSummary, getDiffStat, getChangedFilesBetween, getCommitLogRange, commitExists, isAncestor,
      getDiffNumstat, resolveHolisticDiff,
    } = await import("../../src/dashboard/git.js");
    // git diff and git log take an output-file option; a forged lastSeenSha or
    // preReviewSha of this shape made the unsandboxed poller create the file.
    const out = path.join(env.home, "written-by-git");
    const option = `--output=${out}`;

    expect(getNewCommitSummary(wt, option)).toBe("");
    expect(getDiffStat(wt, `${option}..HEAD`)).toBe("");
    expect(getChangedFilesBetween(wt, option, "HEAD")).toEqual([]);
    expect(getCommitLogRange(wt, option, "HEAD")).toBe("");
    expect(commitExists(env.repoPath, option)).toBe(false);
    expect(isAncestor(wt, option, "HEAD")).toBe(false);
    // preReviewSha and baseBranchSha reach these two.
    expect(getDiffNumstat(wt, option, "HEAD")).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(resolveHolisticDiff(wt, option, "HEAD", ["work.txt"])).toBe("");
    // git names the file after the whole range argument, suffix and all.
    expect(fs.readdirSync(env.home).filter(name => name.startsWith("written-by-git"))).toEqual([]);
  });

  it("syncs a worktree to origin's copy of its branch, not a tag of the same name", async () => {
    const { syncWorktreeToRemote } = await import("../../src/dashboard/git.js");
    git(wt, "push", "-q", "origin", "bold-ash");
    const pushed = git(wt, "rev-parse", "HEAD");
    git(wt, "tag", "origin/bold-ash", git(wt, "rev-parse", "refs/remotes/origin/main"));
    fs.writeFileSync(path.join(wt, "extra.txt"), "extra\n");
    git(wt, "add", "extra.txt");
    git(wt, "commit", "-q", "-m", "unpushed");

    expect(syncWorktreeToRemote(wt, "bold-ash")).toEqual({ ok: true });
    expect(git(wt, "rev-parse", "HEAD")).toBe(pushed);
  });

  it("fast-forwards a merged worktree to origin's base, not a tag of the same name", async () => {
    const { syncWorktreeToBase } = await import("../../src/dashboard/git.js");
    const merged = path.join(env.home, ".garden", "worktrees", "repo", "calm-fir");
    git(env.repoPath, "worktree", "add", "-q", "-b", "calm-fir", merged, "refs/remotes/origin/main");
    const oldTip = git(merged, "rev-parse", "HEAD");
    advanceOrigin("next.txt");
    git(merged, "tag", "origin/main", oldTip);

    expect(syncWorktreeToBase(merged, "main")).toEqual({ ok: true });
    expect(git(merged, "rev-parse", "HEAD")).not.toBe(oldTip);
    expect(git(merged, "rev-parse", "HEAD")).toBe(git(merged, "rev-parse", "refs/remotes/origin/main"));
  });

  it("counts the merge commits a branch adds over origin's real base", async () => {
    const { branchMergeCommits } = await import("../../src/dashboard/git.js");
    git(wt, "checkout", "-q", "-b", "side", "refs/remotes/origin/main");
    fs.writeFileSync(path.join(wt, "side.txt"), "side\n");
    git(wt, "add", "side.txt");
    git(wt, "commit", "-q", "-m", "side");
    git(wt, "checkout", "-q", "bold-ash");
    git(wt, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    // A tag at the tip would empty an abbreviated origin/main..HEAD range.
    git(wt, "tag", "origin/main", "HEAD");

    expect(branchMergeCommits(wt, "main")).toEqual([git(wt, "rev-parse", "HEAD")]);
  });

  it("names the checkout's branch from its full ref, so a same-named tag cannot rename it", async () => {
    const { currentBranch, listBranches, resolveSpawnBase, fastForwardBase } = await import("../../src/dashboard/git.js");
    // A worker can create both in the shared refs store. With them, git's
    // short forms answer "heads/main".
    git(env.repoPath, "branch", "origin/main", "HEAD");
    git(env.repoPath, "tag", "main", "HEAD");

    expect(currentBranch(env.repoPath)).toBe("main");
    expect(resolveSpawnBase({ path: env.repoPath })).toBe("main");
    const listed = listBranches(env.repoPath);
    expect(listed).toContain("main");
    expect(listed.filter(name => /^(heads|remotes)\//.test(name))).toEqual([]);
    // A misread name sent the merge queue down its off-base path, which never
    // advanced the checkout or ran postMerge.
    advanceOrigin("next.txt");
    expect(fastForwardBase(env.repoPath, "main")).toEqual({ ok: true, advanced: "worktree" });
  });

  it("reads the backtest's base reflog for a branch name only, as full SHAs", async () => {
    const { readBaseReflog } = await import("../../src/dashboard/holistic-backtest.js");
    const out = path.join(env.home, "written-by-git");
    expect(() => readBaseReflog(env.repoPath, `--output=${out}`)).toThrow(/not a valid git branch name/);
    expect(fs.existsSync(out)).toBe(false);

    const entries = readBaseReflog(env.repoPath, "main");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("counts how far a build trails origin's real branch, not a same-named tag", async () => {
    const { commitsBehindOrigin } = await import("../../src/dashboard/git.js");
    const build = git(wt, "rev-parse", "HEAD");
    advanceOrigin("next.txt");
    git(wt, "fetch", "-q", "origin");
    git(wt, "tag", "origin/main", build);

    expect(commitsBehindOrigin(wt, build, "main")).toBe(1);
  });

  it("resolves the backtest's --from and --to refs to commits before building its range", async () => {
    fs.writeFileSync(path.join(env.gardenDir, "config.yml"), `projects:\n  repo:\n    path: ${env.repoPath}\n`);
    fs.writeFileSync(path.join(env.repoPath, "feature.txt"), "feature\n");
    git(env.repoPath, "add", "feature.txt");
    git(env.repoPath, "commit", "-q", "-m", "feature");
    const out = fs.mkdtempSync(path.join(env.home, "backtest-"));
    const tmpdir = process.env.TMPDIR;
    process.env.TMPDIR = out;
    try {
      const { runHolisticBacktest } = await import("../../src/dashboard/holistic-backtest.js");
      await runHolisticBacktest(["repo", "bold-ash", "--from", "main~1", "--to", "main"]);
      expect(fs.readFileSync(path.join(out, "holistic-backtest-bold-ash.diff.txt"), "utf8")).toContain("+feature");
    } finally {
      // Assigning undefined stores the string "undefined", which os.tmpdir()
      // then returns for every later test (CI runners set no TMPDIR).
      if (tmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpdir;
    }
  });

  it("never runs a forged base as a fetch option", async () => {
    const { fetchBaseBranch } = await import("../../src/dashboard/git.js");
    expect(() => fetchBaseBranch(wt, `--upload-pack=touch ${marker}`)).toThrow();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refreshes origin's base by its full name, so a same-named tag on origin cannot leave it stale", async () => {
    const { fetchBaseBranch } = await import("../../src/dashboard/git.js");
    const stale = git(wt, "rev-parse", "refs/remotes/origin/main");
    advanceOrigin("base.txt");
    // Any worker can push a tag, and a bare "main" matches origin's tag first.
    const other = path.join(env.home, "other");
    git(other, "push", "-q", "origin", `${stale}:refs/tags/main`);

    fetchBaseBranch(wt, "main");
    expect(git(wt, "rev-parse", "refs/remotes/origin/main")).toBe(git(other, "rev-parse", "HEAD"));
  });

  it("returns non-ASCII paths as themselves, not git's quoted form", async () => {
    const { getChangedFiles, getChangedFilesBetween, listModifiedTrackedFiles, revertChurn } =
      await import("../../src/dashboard/git.js");
    fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
    fs.writeFileSync(path.join(wt, "docs", "café.md"), "doc\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "accented doc");
    expect(getChangedFiles(wt, "main")).toEqual(["docs/café.md", "work.txt"]);
    const base = git(wt, "rev-parse", "refs/remotes/origin/main");
    expect(getChangedFilesBetween(wt, base, "HEAD")).toEqual(["docs/café.md", "work.txt"]);

    // The postMerge churn revert lists and restores the same way.
    fs.writeFileSync(path.join(env.repoPath, "çà.txt"), "tracked\n");
    git(env.repoPath, "add", "çà.txt");
    git(env.repoPath, "commit", "-q", "-m", "accented file");
    fs.writeFileSync(path.join(env.repoPath, "çà.txt"), "churned\n");
    expect(listModifiedTrackedFiles(env.repoPath)).toEqual(["çà.txt"]);
    expect(revertChurn(env.repoPath, new Set())).toEqual(["çà.txt"]);
    expect(fs.readFileSync(path.join(env.repoPath, "çà.txt"), "utf8")).toBe("tracked\n");
  });
});
