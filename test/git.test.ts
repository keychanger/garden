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
  getBranchPR,
  isPRMerged,
  rebaseBranch,
  abortRebase,
  forcePushBranch,
  mergePR,
  getChangedFiles,
  getPRDetails,
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

describe("getBranchPR", () => {
  it("returns PR number when found", () => {
    mockExec.mockReturnValue(JSON.stringify([{ number: 42 }]));
    expect(getBranchPR("/repo", "swift-oak")).toBe(42);
  });

  it("returns null when no PRs", () => {
    mockExec.mockReturnValue("[]");
    expect(getBranchPR("/repo", "swift-oak")).toBeNull();
  });

  it("returns null on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("gh failed");
    });
    expect(getBranchPR("/repo", "swift-oak")).toBeNull();
  });

  it("calls gh with correct args", () => {
    mockExec.mockReturnValue("[]");
    getBranchPR("/repo", "swift-oak");
    expect(mockExec).toHaveBeenCalledWith(
      "gh",
      ["pr", "list", "--head", "swift-oak", "--json", "number", "--limit", "1"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});

describe("isPRMerged", () => {
  it("returns true when state is MERGED", () => {
    mockExec.mockReturnValue(JSON.stringify({ state: "MERGED" }));
    expect(isPRMerged("/repo", 42)).toBe(true);
  });

  it("returns false when state is OPEN", () => {
    mockExec.mockReturnValue(JSON.stringify({ state: "OPEN" }));
    expect(isPRMerged("/repo", 42)).toBe(false);
  });

  it("returns false on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(isPRMerged("/repo", 42)).toBe(false);
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

describe("mergePR", () => {
  it("calls gh pr merge with squash", () => {
    mergePR("/repo", 42);
    expect(mockExec).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "42", "--squash"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("throws on failure", () => {
    mockExec.mockImplementation(() => {
      throw new Error("merge failed");
    });
    expect(() => mergePR("/repo", 42)).toThrow();
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

describe("getPRDetails", () => {
  it("returns title and url", () => {
    mockExec.mockReturnValue(JSON.stringify({
      title: "fix: normalize output",
      url: "https://github.com/org/repo/pull/42",
    }));
    expect(getPRDetails("/repo", 42)).toEqual({
      title: "fix: normalize output",
      url: "https://github.com/org/repo/pull/42",
    });
    expect(mockExec).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "42", "--json", "title,url"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("returns null on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(getPRDetails("/repo", 42)).toBeNull();
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
