// The mid-review-edit marker: onToolActivity stamps reviewInterruptedAt when a
// mutating tool completes while the worker's review is in flight (the poller
// then cancels the pass — see poller.test.ts "cancels the in-flight review").
// These tests pin the hook-side trigger conditions: mutating tools only,
// reviewing state only, stamped once.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  updateWorkerFields: vi.fn(),
}));
vi.mock("../src/dashboard/poller-fifo.js", () => ({
  triggerProjectPoll: vi.fn(),
}));
vi.mock("../src/dashboard/header.js", () => ({
  findWorkerPaneId: vi.fn(() => null),
  refreshDashboard: vi.fn(),
}));
vi.mock("../src/dashboard/tmux.js", () => ({
  getPaneTitle: vi.fn(() => ""),
}));
vi.mock("../src/dashboard/usage.js", () => ({
  maybeRefreshUsage: vi.fn(),
}));
vi.mock("../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "node /usr/local/bin/garden"),
}));
vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
  readAlerts: vi.fn(() => ({ alerts: [] })),
}));
vi.mock("../src/dashboard/continue.js", () => ({
  clearAwaitingInput: vi.fn(),
  clearDoneSentinel: vi.fn(),
  isDoneSet: vi.fn(() => false),
}));
vi.mock("../src/dashboard/git.js", () => ({
  getWorkerBaseBranch: vi.fn(() => "main"),
}));
vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject" })),
}));

import { defaultHookHandlers } from "../src/dashboard/hooks/default.js";
import { updateWorkerFields } from "../src/dashboard/registry.js";
import { triggerProjectPoll } from "../src/dashboard/poller-fifo.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";
import type { HookContext } from "../src/dashboard/workflows/types.js";

function toolCtx(entry: Partial<WorkerEntry>, toolName?: string): HookContext {
  return {
    event: "posttooluse",
    input: toolName ? { tool_name: toolName } : {},
    workerInfo: {
      project: "myproject",
      name: "bold-ash",
      entry: {
        name: "bold-ash",
        sessionId: "sess-1",
        task: "fix stuff",
        worktreePath: "/tmp/wt/myproject/bold-ash",
        branchName: "bold-ash",
        agentStatus: "working",
        ...entry,
      } as WorkerEntry,
    },
  };
}

function interruptStamps(): Array<Record<string, unknown>> {
  return vi.mocked(updateWorkerFields).mock.calls
    .map(c => c[2] as Record<string, unknown>)
    .filter(f => f.reviewInterruptedAt !== undefined);
}

describe("onToolActivity — mid-review-edit marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps reviewInterruptedAt and pokes the poller on a mutating tool during review", () => {
    defaultHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, "Edit"));

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      { reviewInterruptedAt: expect.any(Number) });
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
  });

  it("covers each mutating tool", () => {
    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) {
      vi.clearAllMocks();
      defaultHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, tool));
      expect(interruptStamps(), tool).toHaveLength(1);
    }
  });

  it("ignores read-only tools — an operator Q&A turn must not cancel the review", () => {
    for (const tool of ["Read", "Grep", "Glob", "Bash", "WebFetch", "TodoWrite"]) {
      defaultHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, tool));
    }
    expect(interruptStamps()).toHaveLength(0);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("ignores mutating tools outside the reviewing state", () => {
    for (const prState of [undefined, "working", "merge-pending", "merged", "done"] as const) {
      defaultHookHandlers.onToolActivity(toolCtx({ prState }, "Edit"));
    }
    expect(interruptStamps()).toHaveLength(0);
  });

  it("stamps once — an already-marked review is not re-stamped", () => {
    defaultHookHandlers.onToolActivity(
      toolCtx({ prState: "reviewing", reviewInterruptedAt: 12345 }, "Edit"));
    expect(interruptStamps()).toHaveLength(0);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("ignores a tool event with no tool_name (foreign harness relay)", () => {
    defaultHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }));
    expect(interruptStamps()).toHaveLength(0);
  });
});
