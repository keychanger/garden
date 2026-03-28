import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import { useTmpHome } from "./helpers.js";

vi.mock("../src/dashboard/git.js", () => ({
  rebaseBranch: vi.fn(() => true),
  abortRebase: vi.fn(),
  forcePushBranch: vi.fn(),
  mergePR: vi.fn(),
  removeWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  removeWorker: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmuxDisplay: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const env = useTmpHome();

import {
  rebaseBranch, abortRebase, forcePushBranch, mergePR,
  removeWorktree, pruneWorktrees,
} from "../src/dashboard/git.js";
import { removeWorker } from "../src/dashboard/registry.js";
import { tmuxDisplay } from "../src/dashboard/tmux.js";

async function importQueue() {
  return await import("../src/dashboard/merge-queue.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rebaseBranch).mockReturnValue(true);
});

function makeEntry(overrides: Partial<{
  project: string;
  prNumber: number;
  workerName: string;
  branchName: string;
  worktreePath: string;
  projectPath: string;
  enqueuedAt: string;
}> = {}) {
  return {
    project: "proj",
    prNumber: 42,
    workerName: "swift-oak",
    branchName: "swift-oak",
    worktreePath: "/tmp/wt/proj/swift-oak",
    projectPath: "/repo/proj",
    enqueuedAt: "2026-03-28T00:00:00Z",
    ...overrides,
  };
}

describe("readQueue / writeQueue", () => {
  it("returns empty queue when file missing", async () => {
    const { readQueue } = await importQueue();
    expect(readQueue()).toEqual({ entries: [] });
  });

  it("round-trips entries", async () => {
    const { readQueue, writeQueue } = await importQueue();
    const queue = { entries: [makeEntry()] };
    writeQueue(queue);
    expect(readQueue()).toEqual(queue);
  });

  it("returns empty queue on corrupted file", async () => {
    const { readQueue, QUEUE_FILE } = await importQueue();
    fs.writeFileSync(QUEUE_FILE, "not json!!!");
    expect(readQueue()).toEqual({ entries: [] });
  });
});

describe("enqueue", () => {
  it("adds entry to queue", async () => {
    const { enqueue, readQueue } = await importQueue();
    enqueue(makeEntry({ prNumber: 1 }));
    enqueue(makeEntry({ prNumber: 2, workerName: "bold-fern" }));
    const queue = readQueue();
    expect(queue.entries).toHaveLength(2);
    expect(queue.entries[0].prNumber).toBe(1);
    expect(queue.entries[1].prNumber).toBe(2);
  });
});

describe("getProjectQueue", () => {
  it("filters by project", async () => {
    const { enqueue, getProjectQueue } = await importQueue();
    enqueue(makeEntry({ project: "proj", prNumber: 1 }));
    enqueue(makeEntry({ project: "other", prNumber: 2, workerName: "bold-fern" }));
    enqueue(makeEntry({ project: "proj", prNumber: 3, workerName: "calm-bay" }));
    expect(getProjectQueue("proj")).toHaveLength(2);
    expect(getProjectQueue("other")).toHaveLength(1);
    expect(getProjectQueue("unknown")).toHaveLength(0);
  });
});

describe("processMergeQueue", () => {
  it("does nothing when queue is empty", async () => {
    const { processMergeQueue } = await importQueue();
    const resume = vi.fn();
    processMergeQueue("proj", resume);
    expect(rebaseBranch).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("rebases, pushes, merges, and cleans up on success", async () => {
    const { enqueue, processMergeQueue, readQueue } = await importQueue();
    enqueue(makeEntry());
    const resume = vi.fn();
    processMergeQueue("proj", resume);

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/proj/swift-oak");
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/proj/swift-oak");
    expect(mergePR).toHaveBeenCalledWith("/repo/proj", 42);
    expect(removeWorktree).toHaveBeenCalledWith("/repo/proj", "/tmp/wt/proj/swift-oak");
    expect(pruneWorktrees).toHaveBeenCalledWith("/repo/proj");
    expect(removeWorker).toHaveBeenCalledWith("proj", "swift-oak");
    expect(readQueue().entries).toHaveLength(0);
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes worker on rebase conflict", async () => {
    vi.mocked(rebaseBranch).mockReturnValue(false);
    const { enqueue, processMergeQueue, readQueue } = await importQueue();
    enqueue(makeEntry());
    const resume = vi.fn();
    processMergeQueue("proj", resume);

    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/proj/swift-oak");
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      workerName: "swift-oak",
      prNumber: 42,
    }));
    expect(mergePR).not.toHaveBeenCalled();
    expect(readQueue().entries).toHaveLength(0);
  });

  it("drains multiple entries for same project", async () => {
    const { enqueue, processMergeQueue, readQueue } = await importQueue();
    enqueue(makeEntry({ prNumber: 1, workerName: "swift-oak" }));
    enqueue(makeEntry({ prNumber: 2, workerName: "bold-fern" }));
    const resume = vi.fn();
    processMergeQueue("proj", resume);

    expect(mergePR).toHaveBeenCalledTimes(2);
    expect(readQueue().entries).toHaveLength(0);
  });

  it("only processes entries for the given project", async () => {
    const { enqueue, processMergeQueue, readQueue } = await importQueue();
    enqueue(makeEntry({ project: "other", prNumber: 99, workerName: "other-worker" }));
    enqueue(makeEntry({ project: "proj", prNumber: 1 }));
    const resume = vi.fn();
    processMergeQueue("proj", resume);

    expect(mergePR).toHaveBeenCalledTimes(1);
    expect(mergePR).toHaveBeenCalledWith("/repo/proj", 1);
    expect(readQueue().entries).toHaveLength(1);
    expect(readQueue().entries[0].project).toBe("other");
  });

  it("handles merge failure gracefully", async () => {
    vi.mocked(mergePR).mockImplementation(() => {
      throw new Error("merge failed");
    });
    const { enqueue, processMergeQueue, readQueue } = await importQueue();
    enqueue(makeEntry());
    const resume = vi.fn();
    processMergeQueue("proj", resume);

    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("Failed to merge"),
    );
    expect(readQueue().entries).toHaveLength(0);
    expect(resume).not.toHaveBeenCalled();
  });

  it("stops processing after rebase conflict", async () => {
    vi.mocked(rebaseBranch).mockReturnValue(false);
    const { enqueue, processMergeQueue } = await importQueue();
    enqueue(makeEntry({ prNumber: 1, workerName: "swift-oak" }));
    enqueue(makeEntry({ prNumber: 2, workerName: "bold-fern" }));
    const resume = vi.fn();
    processMergeQueue("proj", resume);

    // Only first entry attempted, second stays in queue
    expect(rebaseBranch).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
