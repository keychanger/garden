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
  getPRReviewDecision,
  getPRReviewFeedback,
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

describe("getPRReviewDecision", () => {
  it("returns decision when present", () => {
    mockExec.mockReturnValue(JSON.stringify({ reviewDecision: "CHANGES_REQUESTED" }));
    expect(getPRReviewDecision("/repo", 42)).toBe("CHANGES_REQUESTED");
  });

  it("returns null when no decision", () => {
    mockExec.mockReturnValue(JSON.stringify({ reviewDecision: null }));
    expect(getPRReviewDecision("/repo", 42)).toBeNull();
  });

  it("returns null when field missing", () => {
    mockExec.mockReturnValue(JSON.stringify({}));
    expect(getPRReviewDecision("/repo", 42)).toBeNull();
  });

  it("returns null on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("failed");
    });
    expect(getPRReviewDecision("/repo", 42)).toBeNull();
  });
});

describe("getPRReviewFeedback", () => {
  it("returns body of latest review", () => {
    mockExec.mockReturnValue(
      JSON.stringify({
        reviews: [
          { body: "first review" },
          { body: "latest feedback" },
        ],
      }),
    );
    expect(getPRReviewFeedback("/repo", 42)).toBe("latest feedback");
  });

  it("returns empty string when no reviews", () => {
    mockExec.mockReturnValue(JSON.stringify({ reviews: [] }));
    expect(getPRReviewFeedback("/repo", 42)).toBe("");
  });

  it("returns empty string when reviews missing", () => {
    mockExec.mockReturnValue(JSON.stringify({}));
    expect(getPRReviewFeedback("/repo", 42)).toBe("");
  });

  it("returns empty string on error", () => {
    mockExec.mockImplementation(() => {
      throw new Error("failed");
    });
    expect(getPRReviewFeedback("/repo", 42)).toBe("");
  });

  it("returns empty string when body is null", () => {
    mockExec.mockReturnValue(
      JSON.stringify({ reviews: [{ body: null }] }),
    );
    expect(getPRReviewFeedback("/repo", 42)).toBe("");
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
