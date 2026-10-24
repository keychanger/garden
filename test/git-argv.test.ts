// Argv-shape tests for src/dashboard/git.ts: verifies the git CLI is invoked
// with the right arguments. Behavior (real git round-trips, conflict
// detection) is covered in test/integration/git-real.test.ts. Keep both —
// argv tests run in milliseconds and catch flag/order regressions cheaply;
// integration tests catch behavioral drift but cost more to run.
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { SAFE_GIT_CONFIG } from "../src/dashboard/git-exec.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  worktreePath,
  createWorktree,
  removeWorktree,
  worktreeExists,
  deleteBranch,
  getBranchHeadSha,
  getRemoteTrackingSha,
  getDiffAgainstBase,
  mergeToBase,
  deleteRemoteBranch,
  rebaseBranch,
  abortRebase,
  hasRebaseInProgress,
  isAncestor,
  ensureNoRebaseInProgress,
  getUnmergedFiles,
  cleanWorktree,
  fastForwardBase,
  fetchBaseBranch,
  forcePushBranch,
  getChangedFiles,
  getCommitSummary,
  pruneWorktrees,
  resolveBaseBranch,
  listBranches,
  resolveSpawnBase,
  currentBranch,
  getRemoteHost,
  branchExistsOnOrigin,
  getWorkerBaseBranch,
  getGitCommonDir,
  tryPublishBranch,
  commitsBehindOrigin,
} from "../src/dashboard/git.js";

const mockExec = vi.mocked(execFileSync);

// Every git garden runs in a worktree carries SAFE_GIT_CONFIG (hooks and
// fsmonitor off); only commands on the operator's own checkout go without it.
const safe = (...args: string[]) => [...SAFE_GIT_CONFIG, ...args];
// `git symbolic-ref --quiet HEAD` on a detached HEAD: exit 1, no output.
const detachedHead = () => { throw Object.assign(new Error("Command failed"), { status: 1 }); };
const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
});

describe("resolveSpawnBase", () => {
  it("refuses a base that is not a valid git branch name, whichever source it came from", () => {
    expect(() => resolveSpawnBase({ path: "/repo" }, "--upload-pack=touch /tmp/x")).toThrow(/not a valid git branch name/);
    expect(() => resolveSpawnBase({ path: "/repo", baseBranch: "a..b" })).toThrow(/not a valid git branch name/);
    // The checkout's HEAD lives in the shared git dir worker sandboxes can write.
    mockExec.mockReturnValue("refs/heads/--x");
    expect(() => resolveSpawnBase({ path: "/repo" })).toThrow(/not a valid git branch name/);
  });

  it("prefers an explicit override over the configured base (no git)", () => {
    const result = resolveSpawnBase({ path: "/repo", baseBranch: "v2-api" }, "release");
    expect(result).toBe("release");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("uses the configured baseBranch when no override (no git)", () => {
    const result = resolveSpawnBase({ path: "/repo", baseBranch: "v2-api" });
    expect(result).toBe("v2-api");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("ignores a whitespace-only override and falls to the configured base", () => {
    const result = resolveSpawnBase({ path: "/repo", baseBranch: "v2-api" }, "   ");
    expect(result).toBe("v2-api");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("falls back to resolveBaseBranch (checkout) when neither is set", () => {
    mockExec.mockReturnValue("refs/heads/feature-x");
    const result = resolveSpawnBase({ path: "/repo" });
    expect(result).toBe("feature-x");
    // Delegated to resolveBaseBranch -> currentBranch (git symbolic-ref).
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("symbolic-ref", "--quiet", "HEAD"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});

describe("worktreePath", () => {
  it("builds path from project and worker name", () => {
    const result = worktreePath("myproject", "swift-oak");
    expect(result).toBe(
      path.join(process.env.HOME!, ".garden", "worktrees", "myproject", "swift-oak"),
    );
  });
});

describe("createWorktree", () => {
  it("creates parent dir and calls git worktree add", () => {
    createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak");
    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/wt/proj", {
      recursive: true,
    });
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "swift-oak", "--end-of-options", "/tmp/wt/proj/worker"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("installs npm dependencies when package.json exists", () => {
    mockFs.existsSync.mockReturnValue(true);
    createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak");
    expect(mockExec).toHaveBeenCalledWith(
      "npm",
      ["install"],
      expect.objectContaining({ cwd: "/tmp/wt/proj/worker", timeout: 120_000 }),
    );
  });

  it("skips npm install when no package.json", () => {
    mockFs.existsSync.mockReturnValue(false);
    createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak");
    const npmCalls = mockExec.mock.calls.filter(c => c[0] === "npm");
    expect(npmCalls).toHaveLength(0);
  });

  it("does not throw when npm install fails", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === "npm") throw new Error("npm install failed");
      return "";
    });
    expect(() => createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak")).not.toThrow();
  });

  it("installs nothing for a tree whose content skipped review", () => {
    // resurrect from a worker's own branch or tip runs this unsandboxed, as the
    // operator. npm lifecycle scripts and a poetry build would run its code,
    // and --ignore-scripts is not enough: the tree's own .npmrc names programs
    // npm runs itself, so neither install runs at all.
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("[tool.poetry]");
    createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak", { useExistingBranch: true, allowScripts: false });
    expect(mockExec.mock.calls.some(c => c[0] === "npm")).toBe(false);
    expect(mockExec.mock.calls.some(c => c[0] === "poetry")).toBe(false);
  });

  it("installs npm and poetry for reviewed content", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("[tool.poetry]");
    createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak", { startPoint: "refs/remotes/origin/main" });
    expect(mockExec).toHaveBeenCalledWith(
      "npm", ["install"], expect.objectContaining({ cwd: "/tmp/wt/proj/worker" }),
    );
    expect(mockExec.mock.calls.some(c => c[0] === "poetry")).toBe(true);
  });

  it("checks out an existing branch by name, and starts a new one only from a SHA or full ref", () => {
    createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak", { useExistingBranch: true });
    createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak", { startPoint: "refs/remotes/origin/main" });
    expect(mockExec.mock.calls.filter(c => c[0] === "git").map(c => c[1])).toEqual([
      // A full ref here would check out a detached HEAD instead of the branch.
      ["worktree", "add", "--end-of-options", "/tmp/wt/proj/worker", "swift-oak"],
      ["worktree", "add", "-b", "swift-oak", "--end-of-options", "/tmp/wt/proj/worker", "refs/remotes/origin/main"],
    ]);
    // resurrect's start point is a tombstone SHA, which a worker can forge.
    mockExec.mockClear();
    expect(() => createWorktree("/repo", "/tmp/wt/proj/worker", "swift-oak", { startPoint: "--output=/tmp/x" })).toThrow();
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("tryPublishBranch", () => {
  it("pushes the branch by its full name and sets its upstream", () => {
    expect(tryPublishBranch("/repo", "release/2026")).toEqual({ ok: true });
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["push", "-u", "--end-of-options", "origin", "refs/heads/release/2026:refs/heads/release/2026"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("refuses a name git would read as an option, without pushing", () => {
    expect(tryPublishBranch("/repo", "--receive-pack=touch /tmp/x").ok).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("removeWorktree", () => {
  it("calls git worktree remove --force", () => {
    removeWorktree("/repo", "/tmp/wt");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/wt", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("does not throw on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a worktree");
    });
    expect(() => removeWorktree("/repo", "/tmp/wt")).not.toThrow();
  });
});

describe("worktreeExists", () => {
  it("returns true when .git exists in path", () => {
    mockFs.existsSync.mockReturnValue(true);
    expect(worktreeExists("/tmp/wt")).toBe(true);
    expect(mockFs.existsSync).toHaveBeenCalledWith("/tmp/wt/.git");
  });

  it("returns false when .git does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(worktreeExists("/tmp/wt")).toBe(false);
  });
});

describe("deleteBranch", () => {
  it("calls git branch -D", () => {
    deleteBranch("/repo", "swift-oak");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "--end-of-options", "swift-oak"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("does not throw on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("branch not found");
    });
    expect(() => deleteBranch("/repo", "swift-oak")).not.toThrow();
  });
});

describe("getBranchHeadSha", () => {
  it("returns HEAD sha", () => {
    mockExec.mockReturnValue("abc123def");
    expect(getBranchHeadSha("/tmp/wt")).toBe("abc123def");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rev-parse", "HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns null on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getBranchHeadSha("/tmp/wt")).toBeNull();
  });
});

describe("getRemoteTrackingSha", () => {
  it("returns remote tracking ref sha", () => {
    mockExec.mockReturnValue("def456abc");
    expect(getRemoteTrackingSha("/tmp/wt", "swift-oak")).toBe("def456abc");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rev-parse", "--verify", "--end-of-options", "refs/remotes/origin/swift-oak"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns null on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("no such ref");
    });
    expect(getRemoteTrackingSha("/tmp/wt", "swift-oak")).toBeNull();
  });
});

describe("getDiffAgainstBase", () => {
  it("returns diff output", () => {
    mockExec.mockReturnValue("diff --git a/file.ts b/file.ts\n+new line");
    expect(getDiffAgainstBase("/tmp/wt", "main")).toBe("diff --git a/file.ts b/file.ts\n+new line");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("diff", "--no-ext-diff", "--no-textconv", "--end-of-options", "refs/remotes/origin/main...HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    mockExec.mockReturnValue("some diff");
    getDiffAgainstBase("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("diff", "--no-ext-diff", "--no-textconv", "--end-of-options", "refs/remotes/origin/develop...HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("throws on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(() => getDiffAgainstBase("/tmp/wt", "main")).toThrow();
  });
});

describe("mergeToBase", () => {
  // The tips come from origin itself, not from the tracking refs a fetch
  // writes: those live in the shared git dir, which every worker sandbox can
  // write, and this is the commit that becomes the base branch. They are asked
  // before the fetch, so the fetch brings in both commits.
  const lsRemote = (sha: string, branch: string) => `${sha}\trefs/heads/${branch}\n`;

  it("asks origin for both tips, fetches, verifies fast-forward, and pushes", () => {
    mockExec
      .mockReturnValueOnce(lsRemote("abc1230", "swift-oak"))
      .mockReturnValueOnce(lsRemote("def4560", "main"))
      .mockReturnValueOnce("")                            // fetch
      .mockReturnValueOnce("")                            // merge-base --is-ancestor
      .mockReturnValueOnce("");                           // push
    mergeToBase("/repo", "swift-oak", "main");
    const calls = mockExec.mock.calls;
    expect(calls[0]).toEqual(["git", safe("ls-remote", "--end-of-options", "origin", "refs/heads/swift-oak"), expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[1]).toEqual(["git", safe("ls-remote", "--end-of-options", "origin", "refs/heads/main"), expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[2]).toEqual(["git", ["fetch", "origin"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[3]).toEqual(["git", safe("merge-base", "--is-ancestor", "--end-of-options", "def4560", "abc1230"), expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[4]).toEqual(["git", ["push", "--no-verify", "--end-of-options", "origin", "abc1230:refs/heads/main"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("reads no tip from a tracking ref", () => {
    mockExec
      .mockReturnValueOnce(lsRemote("abc1230", "swift-oak"))
      .mockReturnValueOnce(lsRemote("def4560", "main"))
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");
    mergeToBase("/repo", "swift-oak", "main");
    const read = mockExec.mock.calls.flatMap(c => (c[1] as string[]));
    expect(read.some(arg => arg.startsWith("refs/remotes/"))).toBe(false);
  });

  it("uses the specified base branch", () => {
    mockExec
      .mockReturnValueOnce(lsRemote("abc1230", "swift-oak"))
      .mockReturnValueOnce(lsRemote("def4560", "develop"))
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");
    mergeToBase("/repo", "swift-oak", "develop");
    const calls = mockExec.mock.calls;
    expect(calls[1]).toEqual(["git", safe("ls-remote", "--end-of-options", "origin", "refs/heads/develop"), expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[4]).toEqual(["git", ["push", "--no-verify", "--end-of-options", "origin", "abc1230:refs/heads/develop"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("refuses to merge a branch origin does not carry", () => {
    // An empty listing is the honest answer, and pushing anything on the
    // strength of it would be pushing a commit nobody named.
    mockExec
      .mockReturnValueOnce("")
      .mockReturnValueOnce(lsRemote("def4560", "main"));
    expect(() => mergeToBase("/repo", "swift-oak", "main")).toThrow(/origin has no refs\/heads\/swift-oak/);
    expect(mockExec.mock.calls.some(c => (c[1] as string[])[0] === "push")).toBe(false);
  });

  it("refuses a listing whose sha is not a sha", () => {
    mockExec
      .mockReturnValueOnce("--output=/tmp/pwned\trefs/heads/swift-oak\n")
      .mockReturnValueOnce(lsRemote("def4560", "main"));
    expect(() => mergeToBase("/repo", "swift-oak", "main")).toThrow(/origin has no/);
  });

  it("surfaces git's own error when origin cannot be asked, rather than calling the branch absent", () => {
    mockExec.mockImplementationOnce(() => { throw new Error("fatal: Could not read from remote repository."); });
    expect(() => mergeToBase("/repo", "swift-oak", "main")).toThrow(/Could not read from remote repository/);
    expect(mockExec.mock.calls.some(c => (c[1] as string[])[0] === "push")).toBe(false);
  });

  it("throws when not a fast-forward", () => {
    mockExec
      .mockReturnValueOnce(lsRemote("abc1230", "swift-oak"))
      .mockReturnValueOnce(lsRemote("def4560", "main"))
      .mockReturnValueOnce("")
      .mockImplementationOnce(() => { throw new Error("not ancestor"); }); // merge-base fails
    expect(() => mergeToBase("/repo", "swift-oak", "main")).toThrow("Cannot fast-forward");
  });

  it("throws on fetch failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("network error");
    });
    expect(() => mergeToBase("/repo", "swift-oak", "main")).toThrow();
  });
});

describe("deleteRemoteBranch", () => {
  it("calls git push origin --delete when remote ref exists", () => {
    mockExec.mockReturnValueOnce("abc123\trefs/heads/swift-oak\n");
    deleteRemoteBranch("/repo", "swift-oak");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--heads", "--end-of-options", "origin", "refs/heads/swift-oak"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["push", "--delete", "--end-of-options", "origin", "refs/heads/swift-oak"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("skips delete when remote ref does not exist", () => {
    deleteRemoteBranch("/repo", "swift-oak");
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--heads", "--end-of-options", "origin", "refs/heads/swift-oak"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("does not throw on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("branch not found");
    });
    expect(() => deleteRemoteBranch("/repo", "swift-oak")).not.toThrow();
  });
});

describe("cleanWorktree", () => {
  it("saves the unstaged changes as a patch, then discards them", () => {
    mockExec
      .mockReturnValueOnce("README.md\0")          // diff --name-only -z
      .mockReturnValueOnce("diff --git a/README.md b/README.md\n"); // diff --binary
    cleanWorktree("/tmp/wt", { project: "proj", worker: "swift-oak" });
    expect(mockExec.mock.calls.map(c => c[1])).toEqual([
      safe("diff", "--name-only", "-z"),
      safe("diff", "--binary", "--no-ext-diff", "--no-textconv"),
      safe("checkout", "--", "."),
    ]);
    const [patchFile, patch] = mockFs.writeFileSync.mock.calls[0] as [string, string];
    expect(patchFile).toContain(path.join(".garden", "control", "reports", "discarded-proj-swift-oak-"));
    expect(patch).toBe("diff --git a/README.md b/README.md\n");
  });

  it("keeps the changes when the patch cannot be written", () => {
    mockExec.mockReturnValueOnce("README.md\0").mockReturnValueOnce("diff\n");
    mockFs.writeFileSync.mockImplementationOnce(() => { throw new Error("EACCES"); });
    cleanWorktree("/tmp/wt");
    expect(mockExec.mock.calls.some(c => (c[1] as string[]).includes("checkout"))).toBe(false);
  });

  it("runs no checkout when nothing is modified", () => {
    cleanWorktree("/tmp/wt");
    expect(mockExec.mock.calls.map(c => c[1])).toEqual([safe("diff", "--name-only", "-z")]);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not throw when there is nothing to clean", () => {
    mockExec.mockImplementation(() => {
      throw new Error("nothing to clean");
    });
    expect(() => cleanWorktree("/tmp/wt")).not.toThrow();
  });
});

describe("rebaseBranch", () => {
  // rebaseBranch probes the repo before choosing a rebase mode: `merge-base
  // --is-ancestor` (has the branch already got the base tip?) and `rev-list
  // --merges` (does it carry merge commits?). Stub both so each test states the
  // branch shape it is exercising.
  function stubBranch(opts: {
    baseIsAncestor?: boolean;
    merges?: string[];
    rebaseFails?: string;
  }) {
    mockExec.mockImplementation((_cmd, args) => {
      const argv = (args as string[]).slice(SAFE_GIT_CONFIG.length);
      if (argv[0] === "merge-base") {
        if (!opts.baseIsAncestor) throw new Error("not an ancestor");
        return "";
      }
      if (argv[0] === "rev-list") return (opts.merges ?? []).join("\n");
      if (argv[0] === "rebase" && opts.rebaseFails) throw new Error(opts.rebaseFails);
      return "";
    });
  }

  it("returns 'ok' on successful rebase", () => {
    stubBranch({});
    expect(rebaseBranch("/tmp/wt", "main")).toEqual({ kind: "ok" });
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rebase", "--end-of-options", "refs/remotes/origin/main"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    stubBranch({});
    rebaseBranch("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rebase", "--end-of-options", "refs/remotes/origin/develop"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("skips the rebase entirely when the branch already contains the base tip", () => {
    stubBranch({ baseIsAncestor: true, merges: ["deadbee"] });
    expect(rebaseBranch("/tmp/wt", "main")).toEqual({ kind: "up-to-date" });
    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["rebase"]),
      expect.anything(),
    );
  });

  it("preserves merge topology with --rebase-merges when the branch has a merge commit", () => {
    stubBranch({ merges: ["deadbee"] });
    expect(rebaseBranch("/tmp/wt", "main")).toEqual({ kind: "ok" });
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rebase", "--rebase-merges", "--end-of-options", "refs/remotes/origin/main"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns 'conflict' when rebase has merge conflicts", () => {
    stubBranch({ rebaseFails: "CONFLICT (content): Merge conflict in file.ts" });
    expect(rebaseBranch("/tmp/wt", "main")).toEqual({ kind: "conflict" });
  });

  it("returns 'conflict' when rebase could not apply a commit", () => {
    stubBranch({ rebaseFails: "error: could not apply abc1234... some commit message" });
    expect(rebaseBranch("/tmp/wt", "main")).toEqual({ kind: "conflict" });
  });

  it("returns an error result carrying the git error for non-conflict failures", () => {
    const msg = "fatal: Unable to create '.git/index.lock': File exists.";
    stubBranch({ rebaseFails: msg });
    const result = rebaseBranch("/tmp/wt", "main");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain(msg);
    }
  });
});

describe("abortRebase", () => {
  it("calls git rebase --abort", () => {
    abortRebase("/tmp/wt");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rebase", "--abort"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("does not throw if not in rebase state", () => {
    mockExec.mockImplementation(() => {
      throw new Error("no rebase in progress");
    });
    expect(() => abortRebase("/tmp/wt")).not.toThrow();
  });
});

describe("hasRebaseInProgress", () => {
  it("returns true when rebase-merge directory exists", () => {
    // git rev-parse --git-path returns the resolved path for the worktree
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("rebase-merge")) return ".git/worktrees/wt/rebase-merge\n";
      if (args.includes("rebase-apply")) return ".git/worktrees/wt/rebase-apply\n";
      return "";
    });
    mockFs.existsSync.mockImplementation((p: unknown) =>
      String(p).includes("rebase-merge"),
    );
    expect(hasRebaseInProgress("/tmp/wt")).toBe(true);
  });

  it("returns true when rebase-apply directory exists", () => {
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("rebase-merge")) return ".git/worktrees/wt/rebase-merge\n";
      if (args.includes("rebase-apply")) return ".git/worktrees/wt/rebase-apply\n";
      return "";
    });
    mockFs.existsSync.mockImplementation((p: unknown) =>
      String(p).includes("rebase-apply"),
    );
    expect(hasRebaseInProgress("/tmp/wt")).toBe(true);
  });

  it("returns false when neither directory exists", () => {
    mockExec.mockReturnValue(".git/worktrees/wt/rebase-merge\n");
    mockFs.existsSync.mockReturnValue(false);
    expect(hasRebaseInProgress("/tmp/wt")).toBe(false);
  });
});

describe("isAncestor", () => {
  it("returns true when ancestor check succeeds", () => {
    expect(isAncestor("/tmp/wt", "refs/remotes/origin/main", "HEAD")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("merge-base", "--is-ancestor", "--end-of-options", "refs/remotes/origin/main", "HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("refuses a revision that is not a SHA, HEAD or full ref, without running git", () => {
    // Registry SHAs are worker-writable; git would read this one as its
    // output-to-file option.
    expect(isAncestor("/tmp/wt", "--output=/tmp/x", "HEAD")).toBe(false);
    expect(isAncestor("/tmp/wt", "origin/main", "HEAD")).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns false when ancestor check fails", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not ancestor");
    });
    expect(isAncestor("/tmp/wt", "refs/remotes/origin/main", "HEAD")).toBe(false);
    expect(mockExec).toHaveBeenCalled();
  });
});

describe("ensureNoRebaseInProgress", () => {
  it("aborts rebase when one is in progress", () => {
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("rebase-merge")) return ".git/worktrees/wt/rebase-merge\n";
      if (args.includes("rebase-apply")) return ".git/worktrees/wt/rebase-apply\n";
      return "";
    });
    mockFs.existsSync.mockImplementation((p: unknown) =>
      String(p).includes("rebase-merge"),
    );
    ensureNoRebaseInProgress("/tmp/wt");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rebase", "--abort"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("does nothing when no rebase is in progress", () => {
    mockExec.mockReturnValue(".git/worktrees/wt/rebase-merge\n");
    mockFs.existsSync.mockReturnValue(false);
    ensureNoRebaseInProgress("/tmp/wt");
    // Only git rev-parse calls, no rebase --abort
    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      safe("rebase", "--abort"),
      expect.anything(),
    );
  });
});

describe("getUnmergedFiles", () => {
  it("returns list of unmerged file paths", () => {
    mockExec.mockReturnValue("src/foo.ts\0src/bar.ts\0");
    expect(getUnmergedFiles("/tmp/wt")).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("diff", "--name-only", "-z", "--diff-filter=U"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns empty array when no conflicts", () => {
    mockExec.mockReturnValue("");
    expect(getUnmergedFiles("/tmp/wt")).toEqual([]);
  });

  it("returns empty array on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getUnmergedFiles("/tmp/wt")).toEqual([]);
  });
});

describe("forcePushBranch", () => {
  it("pushes the worktree HEAD to the named branch on origin", () => {
    // The HEAD: refspec is load-bearing: it pushes whatever the worktree is
    // currently on, regardless of which local branch ref happens to share
    // the worker name. Without it, a worker that committed on a side branch
    // would push a stale named ref and the poller's merge would loop.
    forcePushBranch("/tmp/wt", "my-branch");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("push", "--force-with-lease", "--end-of-options", "origin", "HEAD:refs/heads/my-branch"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("throws on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("rejected");
    });
    expect(() => forcePushBranch("/tmp/wt", "my-branch")).toThrow();
  });
});

describe("getChangedFiles", () => {
  it("returns list of changed files", () => {
    mockExec.mockReturnValue("src/foo.ts\0src/bar.ts\0");
    expect(getChangedFiles("/tmp/wt", "main")).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("diff", "--name-only", "-z", "--end-of-options", "refs/remotes/origin/main...HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    mockExec.mockReturnValue("src/foo.ts\n");
    getChangedFiles("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("diff", "--name-only", "-z", "--end-of-options", "refs/remotes/origin/develop...HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns empty array when no changes", () => {
    mockExec.mockReturnValue("");
    expect(getChangedFiles("/tmp/wt", "main")).toEqual([]);
  });

  it("returns empty array on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getChangedFiles("/tmp/wt", "main")).toEqual([]);
  });
});

describe("getCommitSummary", () => {
  it("returns oneline log of commits ahead of base branch", () => {
    mockExec.mockReturnValue("abc123 fix something\ndef456 add feature\n");
    expect(getCommitSummary("/tmp/wt", "main")).toBe("abc123 fix something\ndef456 add feature");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("log", "--oneline", "--end-of-options", "refs/remotes/origin/main..HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    mockExec.mockReturnValue("abc123 fix something\n");
    getCommitSummary("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("log", "--oneline", "--end-of-options", "refs/remotes/origin/develop..HEAD"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns empty string when no commits ahead", () => {
    mockExec.mockReturnValue("");
    expect(getCommitSummary("/tmp/wt", "main")).toBe("");
  });

  it("returns empty string on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getCommitSummary("/tmp/wt", "main")).toBe("");
  });
});

describe("pruneWorktrees", () => {
  it("calls git worktree prune", () => {
    pruneWorktrees("/repo");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "prune"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("does not throw on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("failed");
    });
    expect(() => pruneWorktrees("/repo")).not.toThrow();
  });
});

describe("resolveBaseBranch", () => {
  it("uses current branch of main checkout", () => {
    mockExec.mockReturnValue("refs/heads/develop");
    expect(resolveBaseBranch("/repo")).toBe("develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("symbolic-ref", "--quiet", "HEAD"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("detects from origin/HEAD when current branch is detached HEAD", () => {
    mockExec
      .mockImplementationOnce(detachedHead) // currentBranch returns "HEAD" for detached
      .mockReturnValueOnce("refs/remotes/origin/master"); // symbolic-ref
    expect(resolveBaseBranch("/repo")).toBe("master");
  });

  it("detects from origin/HEAD when currentBranch fails", () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error("not a git repo"); }) // currentBranch
      .mockReturnValueOnce("refs/remotes/origin/master"); // symbolic-ref
    expect(resolveBaseBranch("/repo")).toBe("master");
  });

  it("falls back to main when nothing works", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a symbolic ref");
    });
    expect(resolveBaseBranch("/repo")).toBe("main");
  });

  it("does not take a base from an origin/HEAD a worker rewrote", () => {
    // The shared refs store is worker-writable.
    mockExec
      .mockReturnValueOnce("HEAD")
      .mockReturnValueOnce("refs/remotes/origin/--upload-pack=touch /tmp/x");
    expect(resolveBaseBranch("/repo")).toBe("main");
  });
});

describe("branchExistsOnOrigin", () => {
  it("returns true when local origin ref exists (no network call)", () => {
    mockExec.mockReturnValue("");
    expect(branchExistsOnOrigin("/repo", "develop")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("show-ref", "--verify", "--quiet", "--end-of-options", "refs/remotes/origin/develop"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("returns false when show-ref exits non-zero", () => {
    mockExec.mockImplementation(() => { throw new Error("not a valid ref"); });
    expect(branchExistsOnOrigin("/repo", "phantom")).toBe(false);
  });
});

describe("getWorkerBaseBranch", () => {
  it("returns pinned entry.baseBranch without touching git", () => {
    expect(getWorkerBaseBranch({ baseBranch: "develop" }, "/repo")).toBe("develop");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("falls back to resolveBaseBranch when entry has no pinned base", () => {
    mockExec.mockReturnValue("refs/heads/feature/x");
    expect(getWorkerBaseBranch({}, "/repo")).toBe("feature/x");
  });
});

describe("fetchBaseBranch", () => {
  it("fetches the base inside the worktree with hooks off and a bounded wait", () => {
    // Runs on every review launch and merge pass; a fetch hung on a dead
    // connection would otherwise hold the project's poller indefinitely.
    fetchBaseBranch("/tmp/wt", "main");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("fetch", "--end-of-options", "origin", "refs/heads/main"),
      expect.objectContaining({ cwd: "/tmp/wt", timeout: 60_000 }),
    );
  });
});

describe("commitsBehindOrigin", () => {
  it("bounds its count well under the watchdog's suspend slack", () => {
    // The watchdog runs this synchronously and reads an iteration that overran
    // SLEEP_SLACK_MS (60s) as machine suspend; git's default bound is 60s.
    mockExec.mockReturnValue("3\n");
    expect(commitsBehindOrigin("/repo", "a".repeat(40), "main")).toBe(3);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rev-list", "--count", "--end-of-options", `${"a".repeat(40)}..refs/remotes/origin/main`),
      expect.objectContaining({ cwd: "/repo", timeout: 10_000 }),
    );
  });
});

describe("fastForwardBase", () => {
  it("advances the working tree to the tip origin reports, not to the tracking ref", () => {
    // The tracking ref is in the shared git dir, which every worker sandbox
    // can write, and this commit is what the checkout becomes and a configured
    // postMerge then builds.
    mockExec
      .mockReturnValueOnce("refs/heads/main\n")  // symbolic-ref HEAD (currentBranch)
      .mockReturnValueOnce("aaaaaaa\trefs/heads/main\n")   // ls-remote origin refs/heads/main
      .mockReturnValueOnce("")        // fetch origin main
      .mockReturnValueOnce("");       // merge --ff-only <sha>
    expect(fastForwardBase("/repo", "main")).toEqual({ ok: true, advanced: "worktree" });
    const calls = mockExec.mock.calls;
    // Asked before the fetch, so the fetch brings in the commit origin named.
    expect(calls[1]).toEqual(["git", safe("ls-remote", "--end-of-options", "origin", "refs/heads/main"), expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[2]).toEqual(["git", ["fetch", "--end-of-options", "origin", "refs/heads/main"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[3]).toEqual(["git", ["merge", "--ff-only", "--end-of-options", "aaaaaaa"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("leaves the checkout alone when origin reports no tip", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/main\n")
      .mockReturnValueOnce("");       // ls-remote: nothing
    expect(fastForwardBase("/repo", "main")).toMatchObject({
      ok: false, reason: "stuck", error: "origin has no refs/heads/main",
    });
    expect(mockExec.mock.calls.some(c => (c[1] as string[])[0] === "merge")).toBe(false);
  });

  it("reports git's own error when origin cannot be asked, not an absent branch", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/main\n")
      .mockImplementationOnce(() => { throw new Error("fatal: Could not read from remote repository."); });
    const result = fastForwardBase("/repo", "main");
    expect(result).toMatchObject({ ok: false, reason: "stuck" });
    expect(result.ok === false && result.reason === "stuck" && result.error).toMatch(/Could not read from remote repository/);
    expect(mockExec.mock.calls.some(c => (c[1] as string[])[0] === "merge")).toBe(false);
  });

  it("advances the ref alone (advanced: ref) when the checkout is parked off-base", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/feature-x\n") // currentBranch
      .mockReturnValueOnce("")            // fetch origin main (refresh tracking ref)
      .mockReturnValueOnce("");           // fetch origin main:main (advance ref)
    expect(fastForwardBase("/repo", "main")).toEqual({ ok: true, advanced: "ref" });
    const calls = mockExec.mock.calls;
    // The working tree is never touched — no `merge`, just the ref-advancing refspec.
    expect(calls[2]).toEqual(["git", ["fetch", "--end-of-options", "origin", "refs/heads/main:refs/heads/main"], expect.objectContaining({ cwd: "/repo" })]);
    expect(mockExec.mock.calls.some(c => (c[1] as string[])[0] === "merge")).toBe(false);
  });

  it("returns diverged with ahead/behind counts when the off-base ref refspec is rejected", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/feature-x\n") // currentBranch
      .mockReturnValueOnce("")            // fetch origin main
      .mockImplementationOnce(() => {     // fetch origin main:main rejected
        throw Object.assign(new Error("Command failed"), {
          stderr: " ! [rejected]        main -> main  (non-fast-forward)\n",
        });
      })
      .mockReturnValueOnce("3\t2\n");     // rev-list --left-right --count main...origin/main
    expect(fastForwardBase("/repo", "main")).toEqual({
      ok: false, reason: "diverged", currentBranch: "feature-x", ahead: 3, behind: 2,
    });
  });

  it("returns checked-out-elsewhere with the worktree path when the base is live in another worktree", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/feature-x\n") // currentBranch
      .mockReturnValueOnce("")            // fetch origin main
      .mockImplementationOnce(() => {     // fetch origin main:main refused
        throw Object.assign(new Error("Command failed"), {
          stderr: "fatal: refusing to fetch into branch 'refs/heads/main' checked out at '/some/wt'\n",
        });
      });
    expect(fastForwardBase("/repo", "main")).toEqual({
      ok: false, reason: "checked-out-elsewhere", currentBranch: "feature-x", checkedOutAt: "/some/wt",
    });
  });

  it("returns dirty when ff-only merge aborts and the working tree has uncommitted changes", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/main\n") // currentBranch
      .mockReturnValueOnce("aaaaaaa\trefs/heads/main\n")  // ls-remote origin refs/heads/main
      .mockReturnValueOnce("")       // fetch origin main
      .mockImplementationOnce(() => { throw new Error("Your local changes to the following files would be overwritten by merge: rules.md"); }) // merge --ff-only
      .mockReturnValueOnce(" M rules.md\n"); // status --porcelain (isWorktreeDirty -> dirty)
    const result = fastForwardBase("/repo", "main");
    expect(result).toMatchObject({ ok: false, reason: "dirty", currentBranch: "main" });
    // A dirty checkout is never reset — that would clobber operator edits.
    expect(mockExec.mock.calls.some(c => (c[1] as string[]).join(" ").startsWith("reset "))).toBe(false);
  });

  it("auto-heals a redundant local commit: resets onto origin when the clean tree already matches", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/main\n") // currentBranch
      .mockReturnValueOnce("aaaaaaa\trefs/heads/main\n")  // ls-remote origin refs/heads/main
      .mockReturnValueOnce("")       // fetch origin main
      .mockImplementationOnce(() => { throw new Error("fatal: Not possible to fast-forward, aborting."); }) // merge --ff-only (diverged)
      .mockReturnValueOnce("")       // status --porcelain (clean)
      .mockReturnValueOnce("")       // diff --quiet HEAD <sha> (exit 0 = identical -> no throw)
      .mockReturnValueOnce("");      // reset --keep <sha>
    expect(fastForwardBase("/repo", "main")).toEqual({ ok: true, advanced: "worktree" });
    const argvs = mockExec.mock.calls.map(c => (c[1] as string[]).join(" "));
    // The tree comparison that licenses the reset, and the reset itself, both
    // name the SHA origin reported — not a ref a worker can rewrite.
    expect(argvs).toContain(
      safe("diff", "--quiet", "--no-ext-diff", "--no-textconv", "--end-of-options", "HEAD", "aaaaaaa").join(" "),
    );
    // No --end-of-options on reset: it rejects the flag before git 2.44.
    // --keep, so a file saved after the clean check is not overwritten.
    expect(argvs).toContain("reset --keep aaaaaaa --");
  });

  it("returns diverged (clean tree, real local commits) when the content differs from origin", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/main\n") // currentBranch
      .mockReturnValueOnce("aaaaaaa\trefs/heads/main\n")  // ls-remote origin refs/heads/main
      .mockReturnValueOnce("")       // fetch origin main
      .mockImplementationOnce(() => { throw new Error("fatal: Not possible to fast-forward, aborting."); }) // merge --ff-only
      .mockReturnValueOnce("")       // status --porcelain (clean)
      .mockImplementationOnce(() => { throw new Error("differences"); }) // diff --quiet (exit 1 = differs -> throw)
      .mockReturnValueOnce("2\t5\n"); // rev-list --left-right --count main...origin/main
    expect(fastForwardBase("/repo", "main")).toEqual({
      ok: false, reason: "diverged", currentBranch: "main", ahead: 2, behind: 5,
    });
    // Real local-only content is never reset away.
    expect(mockExec.mock.calls.some(c => (c[1] as string[]).join(" ").startsWith("reset "))).toBe(false);
  });

  it("returns stuck when fetch fails", () => {
    mockExec
      .mockReturnValueOnce("refs/heads/main\n") // currentBranch
      .mockReturnValueOnce("aaaaaaa\trefs/heads/main\n") // ls-remote origin refs/heads/main
      .mockImplementationOnce(() => { throw new Error("network error"); });
    const result = fastForwardBase("/repo", "main");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "stuck" });
  });
});

describe("currentBranch", () => {
  it("returns the current branch name", () => {
    mockExec.mockReturnValue("refs/heads/my-feature");
    expect(currentBranch("/repo")).toBe("my-feature");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("symbolic-ref", "--quiet", "HEAD"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("returns HEAD when HEAD is detached", () => {
    mockExec.mockImplementation(detachedHead);
    expect(currentBranch("/repo")).toBe("HEAD");
  });

  it("returns null on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(currentBranch("/repo")).toBeNull();
  });
});

describe("getRemoteHost", () => {
  it("extracts host from ssh-style origin URL", () => {
    mockExec.mockReturnValue("git@github.com:owner/repo.git\n");
    expect(getRemoteHost("/repo")).toBe("github.com");
  });

  it("extracts host from https-style origin URL", () => {
    mockExec.mockReturnValue("https://gitlab.example.com/owner/repo.git\n");
    expect(getRemoteHost("/repo")).toBe("gitlab.example.com");
  });

  it("returns null when there is no origin", () => {
    mockExec.mockImplementation(() => {
      throw new Error("no origin");
    });
    expect(getRemoteHost("/repo")).toBeNull();
  });

  it("returns null for unparseable URLs", () => {
    mockExec.mockReturnValue("not-a-url\n");
    expect(getRemoteHost("/repo")).toBeNull();
  });
});

describe("getGitCommonDir", () => {
  it("resolves a relative --git-common-dir against the repo path", () => {
    // Run from the main checkout (how create.ts calls it), git prints the
    // relative ".git"; the resolve-to-absolute branch is the real prod path,
    // since the Codex sandbox writable_roots need an absolute git store path.
    mockExec.mockReturnValue(".git\n");
    expect(getGitCommonDir("/repo/myproject")).toBe("/repo/myproject/.git");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("rev-parse", "--git-common-dir"),
      expect.objectContaining({ cwd: "/repo/myproject" }),
    );
  });

  it("returns an already-absolute --git-common-dir unchanged", () => {
    mockExec.mockReturnValue("/repo/myproject/.git\n");
    expect(getGitCommonDir("/repo/myproject")).toBe("/repo/myproject/.git");
  });

  it("returns null on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getGitCommonDir("/repo/myproject")).toBeNull();
  });
});

describe("listBranches", () => {
  it("offers only names that are valid branch names, so a menu cannot set a base git would misread", () => {
    // refs/heads/--depth=1 is a ref git will store; its short name is an option.
    mockExec.mockReturnValue([
      "refs/heads/main", "refs/heads/--depth=1", "refs/heads/feature/x",
      "refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/release", "",
    ].join("\n"));
    expect(listBranches("/repo")).toEqual(["main", "feature/x", "release"]);
    // Full refnames: %(refname:short) answers "heads/main" once a tag named main exists.
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      safe("for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes/origin"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});
