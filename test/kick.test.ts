import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    readRegistry: vi.fn(() => ({ workers: entries })),
    updateWorkerFields: vi.fn(),
    _setEntries: (project: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[project] = list;
    },
    _clear: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
  };
});

vi.mock("../src/dashboard/poller.js", () => ({
  triggerProjectPoll: vi.fn(),
}));

vi.mock("../src/dashboard/git.js", () => ({
  resolveBaseBranch: vi.fn(() => "main"),
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
  getCommitSummary: vi.fn(() => "abc123 some commit"),
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject" })),
}));

import { kick } from "../src/commands/kick.js";
import { updateWorkerFields } from "../src/dashboard/registry.js";
import { triggerProjectPoll } from "../src/dashboard/poller.js";
import { getCommitSummary } from "../src/dashboard/git.js";
import { tryGetProject } from "../src/config.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const registryMock = await import("../src/dashboard/registry.js") as {
  _setEntries: (project: string, list: WorkerEntry[]) => void;
  _clear: () => void;
} & typeof import("../src/dashboard/registry.js");

function makeWorker(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    name: "bold-ash",
    sessionId: "s1",
    task: "",
    worktreePath: "/tmp/wt/myproject/bold-ash",
    branchName: "bold-ash",
    prState: "working",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  registryMock._clear();
  vi.mocked(getCommitSummary).mockReturnValue("abc123 some commit");
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject" } as ReturnType<typeof tryGetProject>);
});

describe("kick command", () => {
  it("sets pendingReviewAt and pokes the project poller", async () => {
    registryMock._setEntries("myproject", [makeWorker()]);

    const lines = await captureConsoleLog(() => kick(["bold-ash"]));

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject",
      "bold-ash",
      expect.objectContaining({ pendingReviewAt: expect.any(Number) }),
    );
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
    expect(lines.join("\n")).toContain("Kicked myproject/bold-ash");
  });

  it("errors when no worker name is given", async () => {
    await expect(kick([])).rejects.toThrow(/Usage: garden kick <worker>/);
  });

  it("errors when no worker matches the name", async () => {
    await expect(kick(["ghost"])).rejects.toThrow(/No worker found with name 'ghost'/);
  });

  it("errors when multiple workers share the name across projects", async () => {
    registryMock._setEntries("projA", [makeWorker()]);
    registryMock._setEntries("projB", [makeWorker()]);

    await expect(kick(["bold-ash"])).rejects.toThrow(/Multiple workers match 'bold-ash'/);
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("errors when the worker is not in the 'working' state", async () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "reviewing" })]);

    await expect(kick(["bold-ash"])).rejects.toThrow(/is in state 'reviewing'/);
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("errors when Claude is mid-turn (claudeStatus=working)", async () => {
    // A reviewer racing a live worker can force-push over unfinished commits.
    registryMock._setEntries("myproject", [makeWorker({ claudeStatus: "working" })]);

    await expect(kick(["bold-ash"])).rejects.toThrow(/currently working/);
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("errors when Claude is mid-turn (claudeStatus=asking)", async () => {
    registryMock._setEntries("myproject", [makeWorker({ claudeStatus: "asking" })]);

    await expect(kick(["bold-ash"])).rejects.toThrow(/currently asking/);
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("errors when the worker has no commits ahead of base", async () => {
    registryMock._setEntries("myproject", [makeWorker()]);
    vi.mocked(getCommitSummary).mockReturnValue("");

    await expect(kick(["bold-ash"])).rejects.toThrow(/no commits ahead of main/);
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("accepts a worker with undefined prState as 'working'", async () => {
    // New entries may not have prState set yet — treat as working, per
    // registry default in the poller dispatcher.
    registryMock._setEntries("myproject", [makeWorker({ prState: undefined })]);

    await captureConsoleLog(() => kick(["bold-ash"]));

    expect(updateWorkerFields).toHaveBeenCalled();
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
  });

  it("recovers a failing worker whose reason is unparseable-verdict", async () => {
    // The reviewer exited with garbled output — the worker's code is fine.
    // kick should clear the failing pin, transition to working, and re-queue
    // the review without requiring a new commit.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingReason: "unparseable-verdict",
        failingSha: "abc123",
        unparseableReviewAt: Date.now() - 1000,
      }),
    ]);

    const lines = await captureConsoleLog(() => kick(["bold-ash"]));

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject",
      "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        failingReason: undefined,
        failingSha: undefined,
        unparseableReviewAt: undefined,
        reviewRetryCount: undefined,
        reviewRetryAt: undefined,
      }),
    );
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
    expect(lines.join("\n")).toContain("recovered from failing (unparseable-verdict)");
  });

  it("recovers a failing worker whose reason is transient-review", async () => {
    // The reviewer's Claude process couldn't reach the API (5xx / overloaded
    // / rate-limit) for the entire backoff budget. Same recovery shape as
    // unparseable-verdict — code is fine, just retry the reviewer.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingReason: "transient-review",
        failingSha: "abc123",
      }),
    ]);

    const lines = await captureConsoleLog(() => kick(["bold-ash"]));

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject",
      "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        failingReason: undefined,
        failingSha: undefined,
        reviewRetryCount: undefined,
        reviewRetryAt: undefined,
      }),
    );
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
    expect(lines.join("\n")).toContain("recovered from failing (transient-review)");
  });

  it("refuses to recover a failing worker whose reason is 'code'", async () => {
    // Code-side failures require a new commit to retry — kick should refuse
    // and point the operator at the right recovery path.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingReason: "code",
        failingSha: "abc123",
      }),
    ]);

    await expect(kick(["bold-ash"])).rejects.toThrow(/is in state 'failing'.*failingReason='code'/s);
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("recovers a failing worker even when claudeStatus is stuck on 'working'", async () => {
    // Real-world case: reviewer hit a 500, worker transitioned to failing,
    // operator bounced (which sets idle), then a UserPromptSubmit flipped
    // claudeStatus back to "working" — but Claude is now hung and no Stop
    // hook will ever fire. Without this relaxation, kick refuses and the
    // operator has to edit the registry by hand.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingReason: "transient-review",
        failingSha: "abc123",
        claudeStatus: "working",
      }),
    ]);

    await captureConsoleLog(() => kick(["bold-ash"]));

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject",
      "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        failingReason: undefined,
      }),
    );
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
  });

  it("still rejects claudeStatus=working when worker is in normal 'working' state", async () => {
    // The race protection still applies in the non-failing path: a kick on a
    // live working worker could land a review while Claude is making commits.
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "working" }),
    ]);

    await expect(kick(["bold-ash"])).rejects.toThrow(/currently working/);
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("refuses to recover a failing worker whose reason is trellis-flagged", async () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingReason: "trellis-flagged",
      }),
    ]);

    await expect(kick(["bold-ash"])).rejects.toThrow(/trellis resume/);
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});
