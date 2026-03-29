import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxDisplay: vi.fn(),
  setPaneLabel: vi.fn(),
  setPaneVar: vi.fn(),
  getFirstPaneId: vi.fn(() => "%50"),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  addWorker: vi.fn(),
  getAllWorkerNames: vi.fn(() => []),
}));

vi.mock("../src/dashboard/create.js", () => ({
  buildReviewWorkerCommand: vi.fn(() => "review-cmd"),
  resolveGardenRunner: vi.fn(() => "garden"),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));

vi.mock("../src/dashboard/names.js", () => ({
  generateWorkerName: vi.fn(() => "keen-bright-elm"),
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { spawnReviewWorker } from "../src/dashboard/review.js";
import { addWorker } from "../src/dashboard/registry.js";
import { tmux } from "../src/dashboard/tmux.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("spawnReviewWorker", () => {
  it("creates a review worker and returns its name", () => {
    const name = spawnReviewWorker("proj", "/repo/proj", {
      name: "swift-oak",
      worktreePath: "/tmp/wt",
      branchName: "swift-oak",
    }, 42);

    expect(name).toBe("keen-bright-elm");
  });

  it("spawns tmux window with review command", () => {
    spawnReviewWorker("proj", "/repo/proj", {
      name: "swift-oak",
      worktreePath: "/tmp/wt",
      branchName: "swift-oak",
    }, 42);

    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_proj-worker-keen-bright-elm",
      "-c", "/tmp/wt",
      "sh", "-c", "review-cmd",
    );
  });

  it("registers reviewer with parent worker reference", () => {
    spawnReviewWorker("proj", "/repo/proj", {
      name: "swift-oak",
      worktreePath: "/tmp/wt",
      branchName: "swift-oak",
    }, 42);

    expect(addWorker).toHaveBeenCalledWith(
      "proj",
      expect.objectContaining({
        name: "keen-bright-elm",
        role: "reviewer",
        parentWorker: "swift-oak",
        prNumber: 42,
      }),
    );
  });

  it("uses workerName as branchName fallback", () => {
    spawnReviewWorker("proj", "/repo/proj", {
      name: "swift-oak",
      worktreePath: "/tmp/wt",
    }, 10);

    expect(addWorker).toHaveBeenCalledWith(
      "proj",
      expect.objectContaining({
        branchName: "swift-oak",
      }),
    );
  });

  it("uses projectPath as worktreePath fallback", () => {
    spawnReviewWorker("proj", "/repo/proj", {
      name: "swift-oak",
    }, 10);

    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_proj-worker-keen-bright-elm",
      "-c", "/repo/proj",
      "sh", "-c", "review-cmd",
    );
  });
});
