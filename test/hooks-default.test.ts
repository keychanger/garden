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

import { workerHookHandlers } from "../src/dashboard/hooks/default.js";
import { updateWorkerFields } from "../src/dashboard/registry.js";
import { triggerProjectPoll } from "../src/dashboard/poller-fifo.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";
import type { HookContext } from "../src/dashboard/workflows/types.js";

function toolCtx(
  entry: Partial<WorkerEntry>,
  toolName?: string,
  agentId?: string,
): HookContext {
  const input: Record<string, unknown> = {};
  if (toolName) input.tool_name = toolName;
  if (agentId) input.agent_id = agentId;
  return {
    event: "posttooluse",
    input,
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
    workerHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, "Edit"));

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      { reviewInterruptedAt: expect.any(Number) });
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
  });

  it("covers each mutating tool", () => {
    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) {
      vi.clearAllMocks();
      workerHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, tool));
      expect(interruptStamps(), tool).toHaveLength(1);
    }
  });

  it("ignores read-only tools — an operator Q&A turn must not cancel the review", () => {
    for (const tool of ["Read", "Grep", "Glob", "Bash", "WebFetch", "TodoWrite"]) {
      workerHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, tool));
    }
    expect(interruptStamps()).toHaveLength(0);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("ignores mutating tools outside the reviewing state", () => {
    for (const prState of [undefined, "working", "merge-pending", "merged", "done"] as const) {
      workerHookHandlers.onToolActivity(toolCtx({ prState }, "Edit"));
    }
    expect(interruptStamps()).toHaveLength(0);
  });

  it("stamps once — an already-marked review is not re-stamped", () => {
    workerHookHandlers.onToolActivity(
      toolCtx({ prState: "reviewing", reviewInterruptedAt: 12345 }, "Edit"));
    expect(interruptStamps()).toHaveLength(0);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("ignores a tool event with no tool_name (foreign harness relay)", () => {
    workerHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }));
    expect(interruptStamps()).toHaveLength(0);
  });

  it("still cancels an in-flight review when a SUBAGENT mutates the worktree", () => {
    // The agentStatus exclusion below must not reach this: a background
    // subagent's Edit rewrites the same worktree the reviewer is certifying,
    // so the cancel is owed regardless of which thread made the edit.
    workerHookHandlers.onToolActivity(
      toolCtx({ prState: "reviewing" }, "Edit", "a6159cebbfb14984c"));
    expect(interruptStamps()).toHaveLength(1);
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
  });
});

// agentStatus describes the worker's MAIN conversation thread. A background
// subagent's tool call says nothing about it — the main thread can sit blocked
// on an AskUserQuestion (or parked after Stop) while its subagents keep
// completing tools. Claude Code fires the parent session's PostToolUse for
// those, carrying `agent_id`; session_id and transcript_path are byte-identical
// to a main-thread event, so agent_id is the only discriminator.
describe("onToolActivity — subagent tool calls never move agentStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function statusWrites(): Array<unknown> {
    return vi.mocked(updateWorkerFields).mock.calls
      .map(c => (c[2] as Record<string, unknown>).agentStatus)
      .filter(s => s !== undefined);
  }

  it("keeps `asking` when a background subagent completes a tool", () => {
    // The reported bug: a worker called AskUserQuestion (yellow row raised),
    // then a subagent launched seconds earlier completed a tool and cleared
    // the flag — the operator's only signal that the worker needs them.
    workerHookHandlers.onToolActivity(
      toolCtx({ agentStatus: "asking" }, "Read", "a6159cebbfb14984c"));
    expect(statusWrites()).toEqual([]);
  });

  it("keeps `idle` when a background subagent completes a tool", () => {
    // A false `working` here defers the merge gate (isWorkerClaudeWorking).
    workerHookHandlers.onToolActivity(
      toolCtx({ agentStatus: "idle" }, "Bash", "a6159cebbfb14984c"));
    expect(statusWrites()).toEqual([]);
  });

  it("still clears `asking` on the worker's OWN tool completion", () => {
    // The permission-approval path: auto-mode escalates an arbitrary tool, the
    // operator approves, and that tool's completion is what resumes the turn.
    // The catch-all PostToolUse matcher exists for this, so it must not regress.
    workerHookHandlers.onToolActivity(toolCtx({ agentStatus: "asking" }, "Bash"));
    expect(statusWrites()).toEqual(["working"]);
  });

  it("still self-heals a stale `idle` on the worker's own tool completion", () => {
    workerHookHandlers.onToolActivity(toolCtx({ agentStatus: "idle" }, "Read"));
    expect(statusWrites()).toEqual(["working"]);
  });

  it("leaves other statuses alone whichever thread the tool ran on", () => {
    for (const agentId of [undefined, "a6159cebbfb14984c"]) {
      for (const agentStatus of ["working", "paused", "exited"] as const) {
        vi.clearAllMocks();
        workerHookHandlers.onToolActivity(toolCtx({ agentStatus }, "Read", agentId));
        expect(statusWrites(), `${agentStatus}/${agentId}`).toEqual([]);
      }
    }
  });
});
