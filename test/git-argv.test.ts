// Argv-shape tests for src/dashboard/git.ts: verifies the git CLI is invoked
// with the right arguments. Behavior (real git round-trips, conflict
// detection) is covered in test/integration/git-real.test.ts. Keep both —
// argv tests run in milliseconds and catch flag/order regressions cheaply;
// integration tests catch behavioral drift but cost more to run.
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
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
  forcePushBranch,
  getChangedFiles,
  getCommitSummary,
  pruneWorktrees,
  resolveBaseBranch,
  resolveSpawnBase,
  currentBranch,
  getRemoteHost,
  branchExistsOnOrigin,
  getWorkerBaseBranch,
  getGitCommonDir,
} from "../src/dashboard/git.js";

const mockExec = vi.mocked(execFileSync);
const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
});

describe("resolveSpawnBase", () => {
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
    mockExec.mockReturnValue("feature-x");
    const result = resolveSpawnBase({ path: "/repo" });
    expect(result).toBe("feature-x");
    // Delegated to resolveBaseBranch -> currentBranch (git rev-parse).
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
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
      ["worktree", "add", "/tmp/wt/proj/worker", "-b", "swift-oak"],
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
      ["branch", "-D", "swift-oak"],
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
      ["rev-parse", "HEAD"],
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
      ["rev-parse", "origin/swift-oak"],
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
      ["diff", "origin/main...HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    mockExec.mockReturnValue("some diff");
    getDiffAgainstBase("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "origin/develop...HEAD"],
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
  it("fetches, resolves SHAs, verifies fast-forward, and pushes", () => {
    // fetch returns empty, rev-parse returns SHAs, merge-base succeeds, push succeeds
    mockExec
      .mockReturnValueOnce("")           // fetch
      .mockReturnValueOnce("abc123")     // rev-parse origin/swift-oak
      .mockReturnValueOnce("def456")     // rev-parse origin/main
      .mockReturnValueOnce("")           // merge-base --is-ancestor
      .mockReturnValueOnce("");          // push
    mergeToBase("/repo", "swift-oak", "main");
    const calls = mockExec.mock.calls;
    expect(calls[0]).toEqual(["git", ["fetch", "origin"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[1]).toEqual(["git", ["rev-parse", "origin/swift-oak"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[2]).toEqual(["git", ["rev-parse", "origin/main"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[3]).toEqual(["git", ["merge-base", "--is-ancestor", "def456", "abc123"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[4]).toEqual(["git", ["push", "--no-verify", "origin", "abc123:refs/heads/main"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("uses the specified base branch", () => {
    mockExec
      .mockReturnValueOnce("")           // fetch
      .mockReturnValueOnce("abc123")     // rev-parse origin/swift-oak
      .mockReturnValueOnce("def456")     // rev-parse origin/develop
      .mockReturnValueOnce("")           // merge-base --is-ancestor
      .mockReturnValueOnce("");          // push
    mergeToBase("/repo", "swift-oak", "develop");
    const calls = mockExec.mock.calls;
    expect(calls[2]).toEqual(["git", ["rev-parse", "origin/develop"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[4]).toEqual(["git", ["push", "--no-verify", "origin", "abc123:refs/heads/develop"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("throws when not a fast-forward", () => {
    mockExec
      .mockReturnValueOnce("")           // fetch
      .mockReturnValueOnce("abc123")     // rev-parse origin/swift-oak
      .mockReturnValueOnce("def456")     // rev-parse origin/main
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
      ["ls-remote", "--heads", "origin", "swift-oak"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "swift-oak"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("skips delete when remote ref does not exist", () => {
    deleteRemoteBranch("/repo", "swift-oak");
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--heads", "origin", "swift-oak"],
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
  it("discards all unstaged changes before rebase", () => {
    cleanWorktree("/tmp/wt");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["checkout", "--", "."],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
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
      const argv = args as string[];
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
      ["rebase", "origin/main"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    stubBranch({});
    rebaseBranch("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rebase", "origin/develop"],
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
      ["rebase", "--rebase-merges", "origin/main"],
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
      ["rebase", "--abort"],
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
    expect(isAncestor("/tmp/wt", "origin/main", "HEAD")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["merge-base", "--is-ancestor", "origin/main", "HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns false when ancestor check fails", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not ancestor");
    });
    expect(isAncestor("/tmp/wt", "origin/main", "HEAD")).toBe(false);
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
      ["rebase", "--abort"],
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
      ["rebase", "--abort"],
      expect.anything(),
    );
  });
});

describe("getUnmergedFiles", () => {
  it("returns list of unmerged file paths", () => {
    mockExec.mockReturnValue("src/foo.ts\nsrc/bar.ts\n");
    expect(getUnmergedFiles("/tmp/wt")).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
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
      ["push", "--force-with-lease", "origin", "HEAD:my-branch"],
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
    mockExec.mockReturnValue("src/foo.ts\nsrc/bar.ts\n");
    expect(getChangedFiles("/tmp/wt", "main")).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "origin/main...HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    mockExec.mockReturnValue("src/foo.ts\n");
    getChangedFiles("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "origin/develop...HEAD"],
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
      ["log", "--oneline", "origin/main..HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    mockExec.mockReturnValue("abc123 fix something\n");
    getCommitSummary("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline", "origin/develop..HEAD"],
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
    mockExec.mockReturnValue("develop");
    expect(resolveBaseBranch("/repo")).toBe("develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("detects from origin/HEAD when current branch is detached HEAD", () => {
    mockExec
      .mockReturnValueOnce("HEAD") // currentBranch returns "HEAD" for detached
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
});

describe("branchExistsOnOrigin", () => {
  it("returns true when local origin ref exists (no network call)", () => {
    mockExec.mockReturnValue("");
    expect(branchExistsOnOrigin("/repo", "develop")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/remotes/origin/develop"],
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
    mockExec.mockReturnValue("feature/x");
    expect(getWorkerBaseBranch({}, "/repo")).toBe("feature/x");
  });
});

describe("fastForwardBase", () => {
  it("advances the working tree after a clean fetch + ff-only merge on the base branch", () => {
    mockExec
      .mockReturnValueOnce("main\n")  // rev-parse --abbrev-ref HEAD (currentBranch)
      .mockReturnValueOnce("")        // fetch origin main
      .mockReturnValueOnce("");       // merge --ff-only origin/main
    expect(fastForwardBase("/repo", "main")).toEqual({ ok: true, advanced: "worktree" });
    const calls = mockExec.mock.calls;
    expect(calls[1]).toEqual(["git", ["fetch", "origin", "main"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[2]).toEqual(["git", ["merge", "--ff-only", "origin/main"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("advances the ref alone (advanced: ref) when the checkout is parked off-base", () => {
    mockExec
      .mockReturnValueOnce("feature-x\n") // currentBranch
      .mockReturnValueOnce("")            // fetch origin main (refresh tracking ref)
      .mockReturnValueOnce("");           // fetch origin main:main (advance ref)
    expect(fastForwardBase("/repo", "main")).toEqual({ ok: true, advanced: "ref" });
    const calls = mockExec.mock.calls;
    // The working tree is never touched — no `merge`, just the ref-advancing refspec.
    expect(calls[2]).toEqual(["git", ["fetch", "origin", "main:main"], expect.objectContaining({ cwd: "/repo" })]);
    expect(mockExec.mock.calls.some(c => (c[1] as string[])[0] === "merge")).toBe(false);
  });

  it("returns diverged with ahead/behind counts when the off-base ref refspec is rejected", () => {
    mockExec
      .mockReturnValueOnce("feature-x\n") // currentBranch
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
      .mockReturnValueOnce("feature-x\n") // currentBranch
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
      .mockReturnValueOnce("main\n") // currentBranch
      .mockReturnValueOnce("")       // fetch origin main
      .mockImplementationOnce(() => { throw new Error("Your local changes to the following files would be overwritten by merge: rules.md"); }) // merge --ff-only
      .mockReturnValueOnce(" M rules.md\n"); // status --porcelain (isWorktreeDirty -> dirty)
    const result = fastForwardBase("/repo", "main");
    expect(result).toMatchObject({ ok: false, reason: "dirty", currentBranch: "main" });
    // A dirty checkout is never reset — that would clobber operator edits.
    expect(mockExec.mock.calls.some(c => (c[1] as string[]).join(" ").startsWith("reset --hard"))).toBe(false);
  });

  it("auto-heals a redundant local commit: resets onto origin when the clean tree already matches", () => {
    mockExec
      .mockReturnValueOnce("main\n") // currentBranch
      .mockReturnValueOnce("")       // fetch origin main
      .mockImplementationOnce(() => { throw new Error("fatal: Not possible to fast-forward, aborting."); }) // merge --ff-only (diverged)
      .mockReturnValueOnce("")       // status --porcelain (clean)
      .mockReturnValueOnce("")       // diff --quiet HEAD origin/main (exit 0 = identical -> no throw)
      .mockReturnValueOnce("");      // reset --hard origin/main
    expect(fastForwardBase("/repo", "main")).toEqual({ ok: true, advanced: "worktree" });
    expect(mockExec.mock.calls.some(c => (c[1] as string[]).join(" ") === "reset --hard origin/main")).toBe(true);
  });

  it("returns diverged (clean tree, real local commits) when the content differs from origin", () => {
    mockExec
      .mockReturnValueOnce("main\n") // currentBranch
      .mockReturnValueOnce("")       // fetch origin main
      .mockImplementationOnce(() => { throw new Error("fatal: Not possible to fast-forward, aborting."); }) // merge --ff-only
      .mockReturnValueOnce("")       // status --porcelain (clean)
      .mockImplementationOnce(() => { throw new Error("differences"); }) // diff --quiet (exit 1 = differs -> throw)
      .mockReturnValueOnce("2\t5\n"); // rev-list --left-right --count main...origin/main
    expect(fastForwardBase("/repo", "main")).toEqual({
      ok: false, reason: "diverged", currentBranch: "main", ahead: 2, behind: 5,
    });
    // Real local-only content is never reset away.
    expect(mockExec.mock.calls.some(c => (c[1] as string[]).join(" ").startsWith("reset --hard"))).toBe(false);
  });

  it("returns stuck when fetch fails", () => {
    mockExec
      .mockReturnValueOnce("main\n") // currentBranch
      .mockImplementationOnce(() => { throw new Error("network error"); });
    const result = fastForwardBase("/repo", "main");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "stuck" });
  });
});

describe("currentBranch", () => {
  it("returns the current branch name", () => {
    mockExec.mockReturnValue("my-feature");
    expect(currentBranch("/repo")).toBe("my-feature");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      expect.objectContaining({ cwd: "/repo" }),
    );
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
      ["rev-parse", "--git-common-dir"],
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
