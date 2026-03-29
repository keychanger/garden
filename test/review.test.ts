import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxDisplay: vi.fn(),
  setPaneLabel: vi.fn(),
  setPaneVar: vi.fn(),
  getFirstPaneId: vi.fn(() => "%50"),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  addWorker: vi.fn(),
  removeWorker: vi.fn(),
  updateWorkerFields: vi.fn(),
  getAllWorkerNames: vi.fn(() => []),
}));

vi.mock("../src/dashboard/git.js", () => ({
  getBranchPR: vi.fn(() => null),
  isPRMerged: vi.fn(() => false),
  getPRReviewDecision: vi.fn(() => null),
  getPRReviewFeedback: vi.fn(() => ""),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  pruneWorktrees: vi.fn(),
}));

vi.mock("../src/dashboard/merge-queue.js", () => ({
  enqueue: vi.fn(),
  processMergeQueue: vi.fn(),
}));

vi.mock("../src/dashboard/create.js", () => ({
  buildReviewWorkerCommand: vi.fn(() => "review-cmd"),
  buildWorktreeResumeCommand: vi.fn(() => "resume-cmd"),
  resolveGardenRunner: vi.fn(() => "garden"),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: "proj",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: "_proj-worker-test",
  })),
  writeDashState: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));

vi.mock("../src/dashboard/names.js", () => ({
  generateWorkerName: vi.fn(() => "keen-elm"),
}));

vi.mock("../src/config.js", () => ({
  getProject: vi.fn(() => ({ name: "proj", path: "/repo/proj" })),
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handlePostExit, handlePostReview } from "../src/dashboard/review.js";
import { findWorkerByName, addWorker, removeWorker, updateWorkerFields } from "../src/dashboard/registry.js";
import { getBranchPR, isPRMerged, getPRReviewDecision, getPRReviewFeedback, removeWorktree, pruneWorktrees } from "../src/dashboard/git.js";
import { tmux, tmuxDisplay } from "../src/dashboard/tmux.js";
import { buildReviewWorkerCommand, buildWorktreeResumeCommand } from "../src/dashboard/create.js";
import { enqueue, processMergeQueue } from "../src/dashboard/merge-queue.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handlePostExit", () => {
  it("does nothing if worker not in registry", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);
    handlePostExit("unknown", "proj");
    expect(getBranchPR).not.toHaveBeenCalled();
  });

  it("shows message when no PR found", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak",
      sessionId: "abc",
      task: "",
      branchName: "swift-oak",
      worktreePath: "/tmp/wt",
    });
    vi.mocked(getBranchPR).mockReturnValue(null);
    handlePostExit("swift-oak", "proj");
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("without opening a PR"),
    );
  });

  it("updates prNumber and spawns review worker when PR found", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak",
      sessionId: "abc",
      task: "",
      branchName: "swift-oak",
      worktreePath: "/tmp/wt",
    });
    vi.mocked(getBranchPR).mockReturnValue(42);
    handlePostExit("swift-oak", "proj");
    expect(updateWorkerFields).toHaveBeenCalledWith("proj", "swift-oak", { prNumber: 42 });
    expect(addWorker).toHaveBeenCalledWith(
      "proj",
      expect.objectContaining({
        role: "reviewer",
        parentWorker: "swift-oak",
        prNumber: 42,
      }),
    );
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", expect.stringContaining("keen-elm"),
      "-c", "/tmp/wt",
      "sh", "-c", "review-cmd",
    );
  });

  it("uses workerName as branchName fallback", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak",
      sessionId: "abc",
      task: "",
      worktreePath: "/tmp/wt",
    });
    vi.mocked(getBranchPR).mockReturnValue(10);
    handlePostExit("swift-oak", "proj");
    expect(getBranchPR).toHaveBeenCalledWith("/repo/proj", "swift-oak");
  });
});

describe("handlePostReview", () => {
  it("removes reviewer and cleans up if reviewer not found", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);
    handlePostReview("keen-elm", "proj");
    expect(removeWorker).toHaveBeenCalledWith("proj", "keen-elm");
  });

  it("cleans up worktree when PR is merged", () => {
    vi.mocked(findWorkerByName)
      .mockReturnValueOnce({
        name: "keen-elm",
        sessionId: "r1",
        task: "",
        role: "reviewer",
        parentWorker: "swift-oak",
      })
      .mockReturnValueOnce({
        name: "swift-oak",
        sessionId: "abc",
        task: "",
        prNumber: 42,
        worktreePath: "/tmp/wt",
        branchName: "swift-oak",
      });
    vi.mocked(isPRMerged).mockReturnValue(true);

    handlePostReview("keen-elm", "proj");

    expect(removeWorker).toHaveBeenCalledWith("proj", "keen-elm");
    expect(removeWorktree).toHaveBeenCalledWith("/repo/proj", "/tmp/wt");
    expect(pruneWorktrees).toHaveBeenCalledWith("/repo/proj");
    expect(removeWorker).toHaveBeenCalledWith("proj", "swift-oak");
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("merged"),
    );
  });

  it("resumes original worker when changes requested", () => {
    vi.mocked(findWorkerByName)
      .mockReturnValueOnce({
        name: "keen-elm",
        sessionId: "r1",
        task: "",
        role: "reviewer",
        parentWorker: "swift-oak",
      })
      .mockReturnValueOnce({
        name: "swift-oak",
        sessionId: "abc",
        task: "",
        prNumber: 42,
        worktreePath: "/tmp/wt",
        branchName: "swift-oak",
      });
    vi.mocked(isPRMerged).mockReturnValue(false);
    vi.mocked(getPRReviewFeedback).mockReturnValue("Fix the error handling");

    handlePostReview("keen-elm", "proj");

    expect(removeWorker).toHaveBeenCalledWith("proj", "keen-elm");
    expect(buildWorktreeResumeCommand).toHaveBeenCalledWith(
      "proj", "/repo/proj", "swift-oak", "swift-oak", "abc", "garden",
    );
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_proj-worker-swift-oak",
      "-c", "/tmp/wt",
      "sh", "-c", "resume-cmd",
    );
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("Resuming swift-oak"),
    );
  });

  it("enqueues and processes when PR is approved", () => {
    vi.mocked(findWorkerByName)
      .mockReturnValueOnce({
        name: "keen-elm",
        sessionId: "r1",
        task: "",
        role: "reviewer",
        parentWorker: "swift-oak",
      })
      .mockReturnValueOnce({
        name: "swift-oak",
        sessionId: "abc",
        task: "",
        prNumber: 42,
        worktreePath: "/tmp/wt",
        branchName: "swift-oak",
      });
    vi.mocked(isPRMerged).mockReturnValue(false);
    vi.mocked(getPRReviewDecision).mockReturnValue("APPROVED");

    handlePostReview("keen-elm", "proj");

    expect(removeWorker).toHaveBeenCalledWith("proj", "keen-elm");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "proj",
        prNumber: 42,
        workerName: "swift-oak",
        branchName: "swift-oak",
      }),
    );
    expect(processMergeQueue).toHaveBeenCalledWith("proj", expect.any(Function));
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("Queued for merge"),
    );
  });

  it("shows message when reviewer exits without action", () => {
    vi.mocked(findWorkerByName)
      .mockReturnValueOnce({
        name: "keen-elm",
        sessionId: "r1",
        task: "",
        role: "reviewer",
        parentWorker: "swift-oak",
      })
      .mockReturnValueOnce({
        name: "swift-oak",
        sessionId: "abc",
        task: "",
        prNumber: 42,
        worktreePath: "/tmp/wt",
        branchName: "swift-oak",
      });
    vi.mocked(isPRMerged).mockReturnValue(false);
    vi.mocked(getPRReviewDecision).mockReturnValue(null);
    vi.mocked(getPRReviewFeedback).mockReturnValue("");

    handlePostReview("keen-elm", "proj");

    expect(removeWorker).toHaveBeenCalledWith("proj", "keen-elm");
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("without completing review"),
    );
  });

  it("handles missing parent worker gracefully", () => {
    vi.mocked(findWorkerByName)
      .mockReturnValueOnce({
        name: "keen-elm",
        sessionId: "r1",
        task: "",
        role: "reviewer",
        parentWorker: "swift-oak",
      })
      .mockReturnValueOnce(undefined);

    handlePostReview("keen-elm", "proj");
    expect(removeWorker).toHaveBeenCalledWith("proj", "keen-elm");
  });

  it("handles parent without prNumber gracefully", () => {
    vi.mocked(findWorkerByName)
      .mockReturnValueOnce({
        name: "keen-elm",
        sessionId: "r1",
        task: "",
        role: "reviewer",
        parentWorker: "swift-oak",
      })
      .mockReturnValueOnce({
        name: "swift-oak",
        sessionId: "abc",
        task: "",
        // no prNumber
      });

    handlePostReview("keen-elm", "proj");
    expect(removeWorker).toHaveBeenCalledWith("proj", "keen-elm");
  });
});
