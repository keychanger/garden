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
});
