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
  getDiffAgainstMain,
  mergeToMain,
  deleteRemoteBranch,
  rebaseBranch,
  abortRebase,
  forcePushBranch,
  getChangedFiles,
  pruneWorktrees,
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

describe("getDiffAgainstMain", () => {
  it("returns diff output", () => {
    mockExec.mockReturnValue("diff --git a/file.ts b/file.ts\n+new line");
    expect(getDiffAgainstMain("/tmp/wt")).toBe("diff --git a/file.ts b/file.ts\n+new line");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "origin/main...HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("throws on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(() => getDiffAgainstMain("/tmp/wt")).toThrow();
  });
});

describe("mergeToMain", () => {
  it("fetches, checks out main, merges, and pushes", () => {
    mergeToMain("/repo", "swift-oak");
    const calls = mockExec.mock.calls;
    expect(calls[0]).toEqual(["git", ["fetch", "origin"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[1]).toEqual(["git", ["checkout", "main"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[2]).toEqual(["git", ["merge", "--ff-only", "origin/swift-oak"], expect.objectContaining({ cwd: "/repo" })]);
    expect(calls[3]).toEqual(["git", ["push", "origin", "main"], expect.objectContaining({ cwd: "/repo" })]);
  });

  it("throws on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("merge failed");
    });
    expect(() => mergeToMain("/repo", "swift-oak")).toThrow();
  });
});

describe("deleteRemoteBranch", () => {
  it("calls git push origin --delete", () => {
    deleteRemoteBranch("/repo", "swift-oak");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "swift-oak"],
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

describe("rebaseBranch", () => {
  it("returns true on successful rebase", () => {
    expect(rebaseBranch("/tmp/wt")).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rebase", "origin/main"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns false on conflict", () => {
    mockExec.mockImplementation(() => {
      throw new Error("conflict");
    });
    expect(rebaseBranch("/tmp/wt")).toBe(false);
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
  it("calls git push --force-with-lease", () => {
    forcePushBranch("/tmp/wt");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["push", "--force-with-lease"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("throws on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("rejected");
    });
    expect(() => forcePushBranch("/tmp/wt")).toThrow();
  });
});

describe("getChangedFiles", () => {
  it("returns list of changed files", () => {
    mockExec.mockReturnValue("src/foo.ts\nsrc/bar.ts\n");
    expect(getChangedFiles("/tmp/wt")).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "origin/main...HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  it("returns empty array when no changes", () => {
    mockExec.mockReturnValue("");
    expect(getChangedFiles("/tmp/wt")).toEqual([]);
  });

  it("returns empty array on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getChangedFiles("/tmp/wt")).toEqual([]);
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
