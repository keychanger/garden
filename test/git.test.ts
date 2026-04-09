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
  isWorktreeDirty,
  deleteBranch,
  getBranchHeadSha,
  getDiffAgainstBase,
  mergeToBase,
  deleteRemoteBranch,
  rebaseBranch,
  abortRebase,
  cleanWorktree,
  forcePushBranch,
  getChangedFiles,
  getCommitSummary,
  pruneWorktrees,
  resolveBaseBranch,
} from "../src/dashboard/git.js";

const mockExec = vi.mocked(execFileSync);
const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
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

describe("isWorktreeDirty", () => {
  it("returns true when git status --porcelain has output", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockExec.mockReturnValue(" M src/foo.ts\n?? src/new.ts");
    expect(isWorktreeDirty("/tmp/wt")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns false when worktree is clean", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockExec.mockReturnValue("");
    expect(isWorktreeDirty("/tmp/wt")).toBe(false);
  });

  it("returns false when worktree path does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(isWorktreeDirty("/tmp/wt")).toBe(false);
    // Should not invoke git at all when the path is missing.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns false when git fails (broken state should not block kill)", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(isWorktreeDirty("/tmp/wt")).toBe(false);
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
  it("fetches, checks out base branch, merges, and pushes", () => {
    mergeToBase("/repo", "swift-oak", "main");
    const calls = mockExec.mock.calls;
    expect(calls[0]).toEqual(["git", ["fetch", "origin"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[1]).toEqual(["git", ["checkout", "main"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[2]).toEqual(["git", ["merge", "--ff-only", "origin/swift-oak"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[3]).toEqual(["git", ["push", "origin", "main"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("uses the specified base branch", () => {
    mergeToBase("/repo", "swift-oak", "develop");
    const calls = mockExec.mock.calls;
    expect(calls[1]).toEqual(["git", ["checkout", "develop"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[3]).toEqual(["git", ["push", "origin", "develop"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("throws on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("merge failed");
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
  it("runs git checkout -- . to discard unstaged changes", () => {
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
  it("returns 'ok' on successful rebase", () => {
    expect(rebaseBranch("/tmp/wt", "main")).toBe("ok");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rebase", "origin/main"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    rebaseBranch("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rebase", "origin/develop"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns 'conflict' when rebase has merge conflicts", () => {
    mockExec.mockImplementation(() => {
      throw new Error("CONFLICT (content): Merge conflict in file.ts");
    });
    expect(rebaseBranch("/tmp/wt", "main")).toBe("conflict");
  });

  it("returns 'conflict' when rebase could not apply a commit", () => {
    mockExec.mockImplementation(() => {
      throw new Error("error: could not apply abc1234... some commit message");
    });
    expect(rebaseBranch("/tmp/wt", "main")).toBe("conflict");
  });

  it("returns 'error' for non-conflict failures", () => {
    mockExec.mockImplementation(() => {
      throw new Error("fatal: Unable to create '.git/index.lock': File exists.");
    });
    expect(rebaseBranch("/tmp/wt", "main")).toBe("error");
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
      ["log", "--oneline", "main..HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("uses the specified base branch", () => {
    mockExec.mockReturnValue("abc123 fix something\n");
    getCommitSummary("/tmp/wt", "develop");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline", "develop..HEAD"],
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
  it("returns explicit baseBranch from project config", () => {
    expect(resolveBaseBranch("/repo", { baseBranch: "develop" })).toBe("develop");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("detects from origin/HEAD when no config", () => {
    mockExec.mockReturnValue("refs/remotes/origin/master");
    expect(resolveBaseBranch("/repo")).toBe("master");
  });

  it("falls back to main when origin/HEAD is not set", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a symbolic ref");
    });
    expect(resolveBaseBranch("/repo")).toBe("main");
  });

  it("falls back to main when config has no baseBranch", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a symbolic ref");
    });
    expect(resolveBaseBranch("/repo", {})).toBe("main");
  });
});
