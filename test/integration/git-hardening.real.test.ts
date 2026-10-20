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
