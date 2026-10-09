// The mid-review-edit marker: onToolActivity stamps reviewInterruptedAt when a
// mutating tool completes while the worker's review is in flight (the poller
// then cancels the pass — see poller.test.ts "cancels the in-flight review").
// These tests pin the hook-side trigger conditions: mutating tools only,
// reviewing state only, stamped once.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Spread the real module so pure derivations (isDelegating) run for real —
// the delegating-stamp tests below exercise their actual logic; only the I/O
// surface is stubbed.
vi.mock("../src/dashboard/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dashboard/registry.js")>()),
  findWorkerByName: vi.fn(),
  updateWorkerFields: vi.fn(),
  updateWorkerFieldsIf: vi.fn(),
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
  dispatchOwedHandoffCallbacks: vi.fn(),
  isDoneSet: vi.fn(() => false),
}));
vi.mock("../src/dashboard/git.js", () => ({
  getWorkerBaseBranch: vi.fn(() => "main"),
}));
vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject" })),
  // The real registry module (spread below for its pure derivations) imports
  // this at module scope; no test here touches the sessions dir.
  SESSIONS_DIR: "/tmp/garden-test-sessions",
}));

import { workerHookHandlers } from "../src/dashboard/hooks/default.js";
import { execFileSync } from "node:child_process";
import { updateWorkerFields, updateWorkerFieldsIf } from "../src/dashboard/registry.js";
import { triggerProjectPoll } from "../src/dashboard/poller-fifo.js";
import { clearAwaitingInput } from "../src/dashboard/continue.js";
import { refreshDashboard } from "../src/dashboard/header.js";
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
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "TodoWrite"]) {
      workerHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, tool));
    }
    expect(interruptStamps()).toHaveLength(0);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("stamps on a main-thread Bash call whose start was not recorded — a worker prompted mid-review edits through the shell too", () => {
    // wolf/stern-dry-scree, 2026-10-08: the operator prompted the worker while
    // its review ran, the worker rewrote code, tests and spec through python
    // heredocs and `sed -i`, and the reviewer, watching its tree change, failed
    // the review instead of garden cancelling it. Main-thread activity during
    // review always follows a prompt, since the review launches on Stop.
    workerHookHandlers.onToolActivity(toolCtx({ prState: "reviewing" }, "Bash"));
    expect(interruptStamps()).toHaveLength(1);
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
  });

  it("ignores a subagent's Bash call — background agents outlive Stop and mostly read", () => {
    workerHookHandlers.onToolActivity(
      toolCtx({ prState: "reviewing" }, "Bash", "a6159cebbfb14984c"));
    expect(interruptStamps()).toHaveLength(0);
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

// A main-thread Bash call during review cancels it only when the command
// changed the tree: the PreToolUse hook (onToolStarting) records the tree,
// the PostToolUse hook compares. Runs against a real repository, since the
// comparison is what decides whether a read-only answer keeps the review.
describe("Bash during review — cancel only when the command wrote", () => {
  let wt: string;
  let stored: Record<string, string> | undefined;

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: wt, stdio: "ignore" });
  }

  function bashCtx(event: "PreToolUse" | "PostToolUse", agentId?: string): HookContext {
    const ctx = toolCtx({
      prState: "reviewing",
      worktreePath: wt,
      reviewBashBaselines: stored,
    }, "Bash", agentId);
    ctx.input.hook_event_name = event;
    ctx.input.tool_use_id = "toolu_01";
    return ctx;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stored = undefined;
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "garden-review-bash-"));
    git("init", "-q");
    fs.writeFileSync(path.join(wt, "a.txt"), "one\n");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    // Stand in for the registry: apply each conditional write to `stored`.
    vi.mocked(updateWorkerFieldsIf).mockImplementation((_p, _n, decide) => {
      const decision = decide({ prState: "reviewing", reviewBashBaselines: stored } as WorkerEntry);
      if (decision.fields) stored = decision.fields.reviewBashBaselines;
      return decision.result;
    });
  });

  function runBash(command: () => void): void {
    workerHookHandlers.onToolStarting(bashCtx("PreToolUse"));
    command();
    workerHookHandlers.onToolActivity(bashCtx("PostToolUse"));
  }

  it("leaves the review running when the command only read", () => {
    runBash(() => fs.readFileSync(path.join(wt, "a.txt"), "utf-8"));
    expect(interruptStamps()).toHaveLength(0);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
    expect(stored).toEqual({});
  });

  it("cancels when the command rewrote a tracked file", () => {
    runBash(() => fs.writeFileSync(path.join(wt, "a.txt"), "two\n"));
    expect(interruptStamps()).toHaveLength(1);
    expect(triggerProjectPoll).toHaveBeenCalledWith("myproject");
  });

  it("cancels when the command rewrote a file that was already modified", () => {
    // The status line is identical before and after; only the file changed.
    fs.writeFileSync(path.join(wt, "a.txt"), "two\n");
    runBash(() => fs.writeFileSync(path.join(wt, "a.txt"), "three, longer\n"));
    expect(interruptStamps()).toHaveLength(1);
  });

  it("cancels when the command created an untracked file", () => {
    runBash(() => fs.writeFileSync(path.join(wt, "new.txt"), "x\n"));
    expect(interruptStamps()).toHaveLength(1);
  });

  it("cancels when the command committed", () => {
    runBash(() => {
      fs.writeFileSync(path.join(wt, "a.txt"), "two\n");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "edit");
    });
    expect(interruptStamps()).toHaveLength(1);
  });

  it("records nothing outside review or for a subagent", () => {
    const outside = bashCtx("PreToolUse");
    outside.workerInfo!.entry.prState = "working";
    workerHookHandlers.onToolStarting(outside);
    workerHookHandlers.onToolStarting(bashCtx("PreToolUse", "a6159cebbfb14984c"));
    expect(updateWorkerFieldsIf).not.toHaveBeenCalled();
  });

  it("records nothing once the review is already marked for cancel", () => {
    const ctx = bashCtx("PreToolUse");
    ctx.workerInfo!.entry.reviewInterruptedAt = 12345;
    workerHookHandlers.onToolStarting(ctx);
    expect(updateWorkerFieldsIf).not.toHaveBeenCalled();
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

  // A background subagent can finish after the blocked turn ended; that is not
  // the worker resuming, so the question and its sentinel stay.
  it("keeps a blocked question when a subagent completes a tool after the turn ended", () => {
    workerHookHandlers.onToolActivity(toolCtx({
      agentStatus: "idle",
      blockedQuestion: "Run gcloud auth login?",
      blockedAt: 123,
      blockedTurnEndedAt: 456,
    }, "Bash", "a6159cebbfb14984c"));
    expect(clearAwaitingInput).not.toHaveBeenCalled();
    expect(vi.mocked(updateWorkerFields).mock.calls
      .some(c => "blockedQuestion" in (c[2] as Record<string, unknown>))).toBe(false);
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

// A subagent tool event never moves agentStatus, but it IS evidence the
// worker's background work (Task agents, Workflow runs) is still executing —
// so it stamps subagentActivityAt, from which the renderer derives the
// `working bg` display for an idle main thread (isDelegating, registry.ts).
describe("onToolActivity — subagent activity stamp (delegating display)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stampWrites(): number[] {
    return vi.mocked(updateWorkerFields).mock.calls
      .map(c => (c[2] as Record<string, unknown>).subagentActivityAt)
      .filter((s): s is number => s !== undefined);
  }

  it("stamps subagentActivityAt on a subagent tool event without touching agentStatus", () => {
    workerHookHandlers.onToolActivity(
      toolCtx({ agentStatus: "idle", lastStateChangeAt: Date.now() - 60_000 },
        "Read", "a6159cebbfb14984c"));
    expect(stampWrites()).toHaveLength(1);
    const fields = vi.mocked(updateWorkerFields).mock.calls[0][2] as Record<string, unknown>;
    expect(fields.agentStatus).toBeUndefined();
  });

  it("does not stamp on the worker's own tool events", () => {
    workerHookHandlers.onToolActivity(toolCtx({ agentStatus: "working" }, "Read"));
    expect(stampWrites()).toHaveLength(0);
  });

  it("beats the heartbeat throttle and repaints when the stamp flips the delegating display", () => {
    // The main thread just parked (Stop wrote idle, bumping lastEventAt), so a
    // plain heartbeat this soon would be throttled away — but this event is
    // the sole carrier of the idle→`working bg` flip, so it must write and
    // trigger the dashboard refresh.
    const now = Date.now();
    workerHookHandlers.onToolActivity(
      toolCtx({ agentStatus: "idle", lastStateChangeAt: now - 2_000, lastEventAt: now - 2_000 },
        "Read", "a6159cebbfb14984c"));
    expect(stampWrites()).toHaveLength(1);
    expect(refreshDashboard).toHaveBeenCalled();
  });

  it("stays throttled while already delegating — steady-state stamps are heartbeats", () => {
    const now = Date.now();
    workerHookHandlers.onToolActivity(
      toolCtx({
        agentStatus: "idle",
        lastStateChangeAt: now - 60_000,
        subagentActivityAt: now - 5_000, // already delegating
        lastEventAt: now - 5_000,        // within the 10s heartbeat window
      }, "Read", "a6159cebbfb14984c"));
    expect(vi.mocked(updateWorkerFields)).not.toHaveBeenCalled();
    expect(refreshDashboard).not.toHaveBeenCalled();
  });
});

describe("onTurnEnded — owed handoff callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules delivery of callbacks that reached the worker mid-turn", async () => {
    const { dispatchOwedHandoffCallbacks } = await import("../src/dashboard/continue.js");
    const ctx = { ...toolCtx({}), event: "stop" } as HookContext;

    workerHookHandlers.onTurnEnded?.(ctx);

    expect(dispatchOwedHandoffCallbacks).toHaveBeenCalledWith("myproject", "bold-ash");
  });
});

// The Stop hook records background tasks the transcript shows still running so
// an idle row renders `working bg` (background-tasks.ts, isDelegating).
describe("background task tracking", () => {
  let transcript: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-hook-bg-"));
    transcript = path.join(dir, "sess-1.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "running" }] },
      toolUseResult: { backgroundTaskId: "b13krek0m" },
    }) + "\n");
  });

  function hookCtx(event: string, entry: Partial<WorkerEntry>, input: Record<string, unknown> = {}): HookContext {
    const ctx = toolCtx(entry);
    return { ...ctx, event, input: { transcript_path: transcript, ...input } } as HookContext;
  }

  function writtenBackgroundTasks(): unknown[] {
    return vi.mocked(updateWorkerFields).mock.calls
      .map(c => c[2] as Record<string, unknown>)
      .filter(f => "backgroundTasks" in f)
      .map(f => f.backgroundTasks);
  }

  it("records a pending background command at turn end", () => {
    workerHookHandlers.onTurnEnded?.(hookCtx("stop", {}));
    expect(writtenBackgroundTasks()).toEqual([
      { transcriptPath: transcript, offset: fs.statSync(transcript).size, pending: ["b13krek0m"] },
    ]);
  });

  it("skips a Codex worker, whose transcript has no such records", () => {
    workerHookHandlers.onTurnEnded?.(hookCtx("stop", { harness: "codex" }));
    expect(writtenBackgroundTasks()).toEqual([]);
  });

  it("resets at a process start but keeps tasks across compaction", () => {
    const pending = { transcriptPath: transcript, offset: 0, pending: ["b13krek0m"] };
    workerHookHandlers.onSessionStart(hookCtx("sessionstart", { backgroundTasks: pending }, { source: "resume" }));
    expect(writtenBackgroundTasks()).toEqual([
      { transcriptPath: transcript, offset: fs.statSync(transcript).size, pending: [] },
    ]);

    vi.clearAllMocks();
    workerHookHandlers.onSessionStart(hookCtx("sessionstart", { backgroundTasks: pending }, { source: "compact" }));
    expect(writtenBackgroundTasks()).toEqual([]);
  });

  it("lands the reset even inside the heartbeat window — a bounce mid-turn resumes within seconds", () => {
    // The last scan predates a launch the now-dead process made (the record
    // written in beforeEach). A resume SessionStart preserves agentStatus and
    // flips no display, so without the bypass the heartbeat throttle would drop
    // this write and the next Stop's scan would revive that launch as a
    // pending task with no decay.
    const stale = { transcriptPath: transcript, offset: 0, pending: [] };
    workerHookHandlers.onSessionStart(hookCtx(
      "sessionstart",
      { agentStatus: "idle", backgroundTasks: stale, lastEventAt: Date.now() - 1_000 },
      { source: "resume" },
    ));
    expect(writtenBackgroundTasks()).toEqual([
      { transcriptPath: transcript, offset: fs.statSync(transcript).size, pending: [] },
    ]);
  });
});
