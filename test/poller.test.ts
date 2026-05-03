import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync, execFileSync, spawn } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "Looks good.\nCLEAN", stderr: "" })),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ isFIFO: () => true })),
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject", checks: null })),
  tryResolveClaudeProfile: vi.fn(() => null),
  loadConfig: vi.fn(() => ({ projects: { myproject: { path: "/repo/myproject" } } })),
  SESSIONS_DIR: "/tmp/fake-sessions",
  getAutoContinueConfig: vi.fn(() => ({
    enabled: true, usageThreshold: 95, resumeAfterReset: false,
  })),
  setAutoContinueConfig: vi.fn((patch) => ({
    enabled: true, usageThreshold: 95, resumeAfterReset: false, ...patch,
  })),
}));

vi.mock("../src/dashboard/usage.js", () => ({
  readUsageSnapshot: vi.fn(() => null),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  setupStatusBar: vi.fn(),
}));

vi.mock("../src/dashboard/hotkeys.js", () => ({
  setupKeybindings: vi.fn(),
}));

vi.mock("../src/dashboard/create.js", () => ({
  resolveGardenRunner: vi.fn(() => "node /usr/local/bin/garden"),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  getFirstPaneId: vi.fn(() => "%5"),
  windowExists: vi.fn(() => true),
  killWindowSafe: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    readRegistry: vi.fn(() => ({ workers: entries })),
    getWorkers: vi.fn((project: string) => entries[project] ?? []),
    updateWorkerFields: vi.fn(
      (project: string, name: string, fields: Record<string, unknown>) => {
        const list = entries[project];
        if (!list) return;
        const entry = list.find(e => e.name === name);
        if (entry) Object.assign(entry, fields);
      },
    ),
    findWorkerByName: vi.fn(
      (project: string, name: string) => {
        const list = entries[project];
        return list?.find(e => e.name === name);
      },
    ),
    _setEntries: (project: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[project] = list;
    },
    _clear: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
  };
});

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
  })),
  STATE_FILE: "/tmp/fake-sessions/dashboard.state.json",
}));

vi.mock("../src/dashboard/validate.js", () => ({
  healStatusPane: vi.fn(),
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
  readAlerts: vi.fn(() => ({ alerts: [] })),
  alertCount: vi.fn(() => 0),
  clearAlerts: vi.fn(),
  ALERTS_FILE: "/tmp/fake-sessions/dashboard.alerts.json",
}));

vi.mock("../src/dashboard/git.js", () => ({
  getBranchHeadSha: vi.fn(() => "abc123"),
  getRemoteTrackingSha: vi.fn(() => "abc123"),
  getDiffAgainstBase: vi.fn(() => "diff --git a/file.ts b/file.ts"),
  forcePushBranch: vi.fn(),
  mergeToBase: vi.fn(),
  rebaseBranch: vi.fn(() => ({ kind: "ok" })),
  abortRebase: vi.fn(),
  cleanWorktree: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  fastForwardBase: vi.fn(),
  getChangedFiles: vi.fn(() => []),
  getChangedFilesBetween: vi.fn(() => []),
  getCommitSummary: vi.fn(() => "abc123 fix something"),
  getNewCommitSummary: vi.fn(() => "def456 address review feedback"),
  resolveBaseBranch: vi.fn(() => "main"),
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
  syncWorktreeToRemote: vi.fn(() => ({ ok: true })),
  ensureNoRebaseInProgress: vi.fn(),
  hasRebaseInProgress: vi.fn(() => false),
  isAncestor: vi.fn(() => true),
  getUnmergedFiles: vi.fn(() => []),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "test rules"),
}));

vi.mock("../src/dashboard/continue.js", () => ({
  dispatchDelayedAutoContinue: vi.fn(),
  dispatchDelayedContinue: vi.fn(),
  continueWorker: vi.fn(),
  continueWorkerAfterMerge: vi.fn(),
  isDoneSet: vi.fn(() => false),
  donePath: vi.fn((wt: string) => `${wt}/.garden-done`),
  clearDoneSentinel: vi.fn(),
}));

import fs from "node:fs";
import { poll, postPush, restartLongLivedPollers } from "../src/dashboard/poller.js";
import { tryGetProject } from "../src/config.js";
import { updateWorkerFields, findWorkerByName } from "../src/dashboard/registry.js";
import {
  getBranchHeadSha, getRemoteTrackingSha, deleteRemoteBranch,
  forcePushBranch, mergeToBase, rebaseBranch, abortRebase,
  fastForwardBase,
  getChangedFiles, getChangedFilesBetween,
  getCommitSummary, getNewCommitSummary, getDiffAgainstBase,
  syncWorktreeToRemote,
  ensureNoRebaseInProgress, hasRebaseInProgress, isAncestor, getUnmergedFiles,
} from "../src/dashboard/git.js";
import { tmux, windowExists, getFirstPaneId, killWindowSafe } from "../src/dashboard/tmux.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { log } from "../src/dashboard/log.js";
import { dispatchDelayedAutoContinue, isDoneSet } from "../src/dashboard/continue.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const registryMock = await import("../src/dashboard/registry.js") as {
  _setEntries: (project: string, list: WorkerEntry[]) => void;
  _clear: () => void;
} & typeof import("../src/dashboard/registry.js");

function makeWorker(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    name: "bold-ash",
    sessionId: "sess-1",
    task: "fix stuff",
    worktreePath: "/tmp/wt/myproject/bold-ash",
    branchName: "bold-ash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  registryMock._clear();
  // Re-establish factory defaults after reset
  vi.mocked(windowExists).mockReturnValue(true);
  vi.mocked(getFirstPaneId).mockReturnValue("%5");
  vi.mocked(getChangedFiles).mockReturnValue([]);
  vi.mocked(getDiffAgainstBase).mockReturnValue("diff --git a/file.ts b/file.ts");
  vi.mocked(getCommitSummary).mockReturnValue("abc123 fix something");
  vi.mocked(getNewCommitSummary).mockReturnValue("def456 address review feedback");
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: undefined } as ReturnType<typeof tryGetProject>);
  vi.mocked(getBranchHeadSha).mockReturnValue("abc123");
  vi.mocked(getRemoteTrackingSha).mockReturnValue("abc123");
  vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
  vi.mocked(hasRebaseInProgress).mockReturnValue(false);
  vi.mocked(isAncestor).mockReturnValue(true);
  vi.mocked(getUnmergedFiles).mockReturnValue([]);
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

// In the new model, review is launched when pendingReviewAt is set on the
// worker. Per STATUS.md invariant 2, working→reviewing requires the Stop
// hook to fire with new commits — and the Stop hook is the only place that
// sets pendingReviewAt. Idle workers without pendingReviewAt are NOT
// candidates for review even if they have stale commits ahead of base.
describe("poll — working state", () => {
  it("launches review when pendingReviewAt is set and commits exist", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    // The prompt file path matches the convention in poller.ts:87
    // (`${project}-${worker}-review-prompt.txt`). Bare toHaveBeenCalled would
    // pass even if writeFileSync wrote garbage to a wrong path.
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("myproject-bold-ash-review-prompt.txt"),
      expect.any(String),
    );
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", expect.any(String), "-n", "_myproject-review-bold-ash",
      "-c", "/tmp/wt/myproject/bold-ash", "bash", "-c", expect.any(String),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
      }),
    );
  });

  it("does NOT review an idle worker without pendingReviewAt (the regression)", () => {
    // This is the spec invariant 2 case: a worker may be idle with stale
    // commits ahead of base for any reason — Q&A session, abandoned branch,
    // resume-after-restart. Without pendingReviewAt set by the Stop hook,
    // we MUST NOT launch a review on it.
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "idle" }),
    ]);
    // Commits ahead of base, but no pendingReviewAt
    vi.mocked(getCommitSummary).mockReturnValue("abc123 some old commit");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(tmux).not.toHaveBeenCalledWith(
      "new-window", expect.anything(), expect.anything(), expect.anything(),
      "-n", expect.stringContaining("review"),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("does nothing when claudeStatus is working (Claude still active)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "working", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
  });

  it("clears pendingReviewAt when commits no longer exist", () => {
    // Stop hook said commits existed; by the time the poller wakes, they're
    // gone (force-pushed away, base advanced past them, etc.). Clear the
    // flag so we don't keep retrying.
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "idle", pendingReviewAt: Date.now() }),
    ]);
    vi.mocked(getCommitSummary).mockReturnValue("");

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ pendingReviewAt: undefined }),
    );
    expect(forcePushBranch).not.toHaveBeenCalled();
  });

  it("launchReview clears pendingReviewAt", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    const launchCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "reviewing",
    );
    expect(launchCall).toBeDefined();
    expect((launchCall![2] as Record<string, unknown>).pendingReviewAt).toBeUndefined();
  });

  it("allows multiple workers to transition independently", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ name: "calm-bay", prState: "reviewing", claudeStatus: "idle",
        sessionId: "s1", task: "t1", reviewWindowName: "_myproject-review-calm-bay",
        worktreePath: "/tmp/wt/myproject/calm-bay", branchName: "calm-bay",
        lastSeenSha: "abc123" }),
      makeWorker({ name: "bold-ash", prState: "working", claudeStatus: "idle",
        pendingReviewAt: Date.now(),
        sessionId: "s2", task: "t2" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("bold-ash"),
    );

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });

  it("launchReview stamps reviewStartedAt and arms the timeout poke", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    const launchCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "reviewing",
    );
    expect(launchCall).toBeDefined();
    expect((launchCall![2] as Record<string, unknown>).reviewStartedAt).toEqual(expect.any(Number));
    // A 30-minute sleep must be armed so a hung reviewer eventually pokes the FIFO.
    const timeoutSpawn = vi.mocked(spawn).mock.calls.find(
      c => String(c[1]?.[1] ?? "").startsWith("sleep 1800"),
    );
    expect(timeoutSpawn).toBeDefined();
  });
});

describe("poll — review/resolve timeout", () => {
  const THIRTY_ONE_MIN_AGO = Date.now() - 31 * 60 * 1000;
  // The cap is `Date.now() - reviewStartedAt > REVIEW_TIMEOUT_MS` (strict >).
  // At exactly 30 minutes the reviewer is NOT yet timed out; at 30 minutes +
  // 1ms it IS. These two boundary tests pin the > vs >= semantics.
  const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

  it("reviewing → failing when the reviewer exceeds the 30-minute cap", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        reviewStartedAt: THIRTY_ONE_MIN_AGO,
        lastSeenSha: "abc123",
      }),
    ]);
    // Reviewer window is still alive — that is what makes this a timeout,
    // not a normal completion.
    vi.mocked(windowExists).mockReturnValue(true);

    poll("myproject");

    expect(killWindowSafe).toHaveBeenCalledWith("_myproject-review-bold-ash");
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "review",
        worker: "bold-ash",
        message: expect.stringContaining("30-minute timeout"),
      }),
    );
    const call = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(call).toBeDefined();
    const fields = call![2] as Record<string, unknown>;
    expect(fields.failCount).toBe(1);
    expect(fields.reviewWindowName).toBeUndefined();
    expect(fields.reviewStartedAt).toBeUndefined();
  });

  it("resolving → failing when the resolver exceeds the cap, clears mergePendingAt", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "resolving",
        reviewWindowName: "_myproject-review-bold-ash",
        reviewStartedAt: THIRTY_ONE_MIN_AGO,
        mergePendingAt: new Date(Date.now() - 2000).toISOString(),
        preResolveSha: "pre-sha",
        resolveAttempts: 1,
        lastSeenSha: "abc123",
      }),
    ]);
    vi.mocked(windowExists).mockReturnValue(true);

    poll("myproject");

    expect(killWindowSafe).toHaveBeenCalledWith("_myproject-review-bold-ash");
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "review",
        message: expect.stringContaining("Resolver"),
      }),
    );
    const call = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(call).toBeDefined();
    const fields = call![2] as Record<string, unknown>;
    // Resolver timeouts abandon the merge slot; the budget retry path is
    // skipped because the timer's job is to break a wedge, not to keep
    // retrying a wedged run.
    expect(fields.mergePendingAt).toBeUndefined();
    expect(fields.reviewStartedAt).toBeUndefined();
  });

  it("does not fire when the review window is already gone (normal completion)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        reviewStartedAt: THIRTY_ONE_MIN_AGO,
        lastSeenSha: "abc123",
      }),
    ]);
    // Window is gone and no result file — this is a regular "review process
    // failed" path, which must increment failCount via the normal flow, not
    // via the timeout alert message.
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockReturnValue(false);

    poll("myproject");

    expect(killWindowSafe).not.toHaveBeenCalled();
    const timeoutAlert = vi.mocked(addAlert).mock.calls.find(
      c => String((c[0] as { message: string }).message).includes("30-minute timeout"),
    );
    expect(timeoutAlert).toBeUndefined();
  });

  it("does not fire when the reviewer is still within the cap", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        reviewStartedAt: Date.now() - 60_000, // 1 minute ago
        lastSeenSha: "abc123",
      }),
    ]);
    vi.mocked(windowExists).mockReturnValue(true);

    poll("myproject");

    expect(killWindowSafe).not.toHaveBeenCalled();
    expect(addAlert).not.toHaveBeenCalled();
    // Normal "still in-flight" path — no transition.
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("does NOT time out at exactly 30 minutes (boundary, > cap)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        reviewStartedAt: Date.now() - REVIEW_TIMEOUT_MS,
        lastSeenSha: "abc123",
      }),
    ]);
    vi.mocked(windowExists).mockReturnValue(true);

    poll("myproject");

    expect(killWindowSafe).not.toHaveBeenCalled();
    const timeoutAlert = vi.mocked(addAlert).mock.calls.find(
      c => String((c[0] as { message: string }).message).includes("30-minute timeout"),
    );
    expect(timeoutAlert).toBeUndefined();
  });

  it("times out at 30 minutes + 1ms (boundary, just past cap)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        reviewStartedAt: Date.now() - REVIEW_TIMEOUT_MS - 1,
        lastSeenSha: "abc123",
      }),
    ]);
    vi.mocked(windowExists).mockReturnValue(true);

    poll("myproject");

    expect(killWindowSafe).toHaveBeenCalledWith("_myproject-review-bold-ash");
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("30-minute timeout"),
      }),
    );
  });
});

describe("poll — reviewing state (async)", () => {
  it("returns false while review window is still running", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    // Review window still exists, head SHA unchanged
    vi.mocked(windowExists).mockImplementation(() => true);

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergeToBase).not.toHaveBeenCalled();
  });

  it("transitions to merge-pending when review returns CLEAN", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Looks good.\nCLEAN";
      return "{}";
    });

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "merge-pending",
        mergePendingAt: expect.any(String),
        lastReviewBody: "Looks good.",
        reviewWindowName: undefined,
      }),
    );
    // Must poke the poller so it processes handleMergePending next tick
    expect(spawn).toHaveBeenCalledWith(
      "bash",
      ["-c", expect.stringContaining("sleep 0")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("transitions to merge-pending when review returns FIXED", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Added missing tests.\nFIXED";
      return "{}";
    });

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
    expect(spawn).toHaveBeenCalledWith(
      "bash",
      ["-c", expect.stringContaining("sleep 0")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("resets to working when force-push fails after review", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Looks good.\nCLEAN";
      return "{}";
    });
    vi.mocked(forcePushBranch).mockImplementation(() => { throw new Error("push failed"); });

    poll("myproject");

    expect(mergeToBase).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working", reviewWindowName: undefined }),
    );
  });

  it("transitions to failing when reviewer returns FAILED", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Fundamental architecture issue.\nFAILED";
      return "{}";
    });

    poll("myproject");

    expect(mergeToBase).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        reviewWindowName: undefined,
      }),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "review",
        worker: "bold-ash",
      }),
    );
  });

  it("parses verdict with trailing period (CLEAN.)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Looks good.\nCLEAN.";
      return "{}";
    });

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
  });

  it("parses verdict with trailing blank lines", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Looks good.\nCLEAN\n\n";
      return "{}";
    });

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
  });

  it("parses verdict that appears mid-output, not on the last line", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) {
        return "Reviewed 3 findings.\nFIXED\nTSC CLEAN, VITEST 856/856";
      }
      return "{}";
    });

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
  });

  it("re-queues review when verdict is unparseable but reviewer committed work", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) {
        return "TSC CLEAN, VITEST 856/856 (WAS 848 BEFORE THE 8 NEW TESTS)";
      }
      return "{}";
    });
    // Reviewer advanced HEAD past the pre-launch SHA.
    vi.mocked(getBranchHeadSha).mockReturnValue("post789");

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        unparseableReviewAt: expect.any(Number),
        reviewWindowName: undefined,
        preReviewSha: undefined,
      }),
    );
  });

  it("falls through to failing when unparseable verdict retry is already exhausted", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
        unparseableReviewAt: Date.now() - 1000,
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "still no verdict line";
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("post789");

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        // Pin failingSha so handleFailing's debounce gate refuses to retry the
        // same broken commit. Without this, the worker loops failing→working
        // every DEBOUNCE_MS forever when no new commits arrive.
        failingSha: "post789",
      }),
    );
  });

  it("falls through to failing when verdict unparseable and reviewer made no commits", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "something went wrong";
      return "{}";
    });
    // HEAD still at the pre-review SHA — reviewer did nothing.
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        // Pin failingSha so handleFailing's debounce gate refuses to retry.
        failingSha: "pre456",
      }),
    );
  });

  it("transitions to failing when review result is missing", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockReturnValue(false);

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        reviewWindowName: undefined,
      }),
    );
  });

  it("aborts review when worker pushes new commits after reviewer exits", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "old-sha" }),
    ]);
    vi.mocked(getRemoteTrackingSha).mockReturnValue("newer-sha");
    // Reviewer window has exited; SHA change is therefore a genuine worker push.
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(getCommitSummary).mockReturnValue("abc123 new work");

    poll("myproject");

    const call = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "working",
    );
    expect(call).toBeDefined();
    const fields = call![2] as Record<string, unknown>;
    expect(fields.reviewWindowName).toBeUndefined();
    // pendingReviewAt must be set so handleWorking launches a fresh review —
    // without this repair, the worker would stall in `working` with no poke.
    expect(fields.pendingReviewAt).toEqual(expect.any(Number));
    expect(fields.resolveAttempts).toBe(0);
    expect(mergeToBase).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      "bash",
      ["-c", expect.stringContaining("sleep 0")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("does NOT reset to working when SHA changes but reviewer window is still alive", () => {
    // Race-fix regression: a mid-session reviewer push changes origin/<branch>
    // before the reviewer exits. We must attribute that to the reviewer, not
    // the worker — otherwise the reviewer's own progress wrongly kills review.
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "old-sha" }),
    ]);
    vi.mocked(getRemoteTrackingSha).mockReturnValue("newer-sha");
    vi.mocked(windowExists).mockReturnValue(true); // reviewer still running

    poll("myproject");

    const resetCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "working",
    );
    expect(resetCall).toBeUndefined();
  });

  it("omits pendingReviewAt on worker-push reset when no commits are ahead of base", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "old-sha" }),
    ]);
    vi.mocked(getRemoteTrackingSha).mockReturnValue("newer-sha");
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(getCommitSummary).mockReturnValue(""); // no commits ahead of base

    poll("myproject");

    const call = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "working",
    );
    expect(call).toBeDefined();
    const fields = call![2] as Record<string, unknown>;
    // No commits means no work to review — don't set pendingReviewAt.
    expect(fields.pendingReviewAt).toBeUndefined();
  });
});

describe("poll — merge-pending state", () => {
  it("merges when rebase is clean", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);

    poll("myproject");

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "main");
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(mergeToBase).toHaveBeenCalledWith("/repo/myproject", "bold-ash", "main");
    expect(deleteRemoteBranch).toHaveBeenCalledWith("/repo/myproject", "bold-ash");
    expect(fastForwardBase).toHaveBeenCalledWith("/repo/myproject", "main", { project: "myproject", worker: "bold-ash" });
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "merged",
        mergedAt: expect.any(String),
        failCount: 0,
        mergePendingAt: undefined,
      }),
    );
  });

  it("clears merged to working when worker is already active (race)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "working",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);

    poll("myproject");

    // finalizeMerge should detect the race and clear "merged" immediately.
    const calls = vi.mocked(updateWorkerFields).mock.calls.filter(
      c => c[1] === "bold-ash",
    );
    // First call sets "merged", second clears it to "working".
    const mergedCall = calls.find(c => (c[2] as Record<string, unknown>).prState === "merged");
    const workingCall = calls.find(c => (c[2] as Record<string, unknown>).prState === "working");
    expect(mergedCall).toBeDefined();
    expect(workingCall).toBeDefined();
    expect((workingCall![2] as Record<string, unknown>).mergedAt).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      "poller", "worker already active after merge, clearing terminal state",
      expect.objectContaining({ worker: "bold-ash" }),
    );
  });

  it("dispatches auto-continue when worker is idle and no .garden-done sentinel", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(isDoneSet).mockReturnValue(false);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).toHaveBeenCalledWith(
      expect.any(String), "myproject", "bold-ash",
    );
    expect(log.info).toHaveBeenCalledWith(
      "poller", "auto-continued worker after merge",
      expect.objectContaining({ worker: "bold-ash" }),
    );
  });

  it("sets prState=done (not merged) and skips auto-continue when .garden-done is set at merge time", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(isDoneSet).mockReturnValue(true);

    poll("myproject");

    const calls = vi.mocked(updateWorkerFields).mock.calls.filter(c => c[1] === "bold-ash");
    const doneCall = calls.find(c => (c[2] as Record<string, unknown>).prState === "done");
    const mergedCall = calls.find(c => (c[2] as Record<string, unknown>).prState === "merged");
    expect(doneCall).toBeDefined();
    expect(mergedCall).toBeUndefined();

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "poller", "auto-continue skipped",
      expect.objectContaining({
        worker: "bold-ash",
        data: expect.objectContaining({ reason: "done-sentinel" }),
      }),
    );
  });

  it("skips auto-continue when claudeStatus is working (race)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "working",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("skips auto-continue inside the idempotency window", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastAutoContinueAt: Date.now() - 1000, // 1s ago, well inside the 10s window
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(isDoneSet).mockReturnValue(false);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "poller", "auto-continue skipped",
      expect.objectContaining({
        data: expect.objectContaining({ reason: "idempotency-window" }),
      }),
    );
  });

  it("keeps merged when worker is idle (no race) and dispatches auto-continue", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);

    poll("myproject");

    const calls = vi.mocked(updateWorkerFields).mock.calls.filter(
      c => c[1] === "bold-ash",
    );
    const mergedCall = calls.find(c => (c[2] as Record<string, unknown>).prState === "merged");
    const workingCall = calls.find(c => (c[2] as Record<string, unknown>).prState === "working");
    const autoContinueCall = calls.find(
      c => (c[2] as Record<string, unknown>).lastAutoContinueAt !== undefined,
    );
    expect(mergedCall).toBeDefined();
    // No follow-up "working" clear — that path is the race-handler test.
    expect(workingCall).toBeUndefined();
    // Auto-continue fires on idle worker with no .garden-done sentinel.
    expect(autoContinueCall).toBeDefined();
  });

  it("syncs worktree to merged tip and persists reviewer-changed files", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(syncWorktreeToRemote).mockReturnValue({ ok: true });
    // Post-sync HEAD differs from preReviewSha so the diff path runs.
    vi.mocked(getBranchHeadSha).mockImplementation((p: string) =>
      p === "/tmp/wt/myproject/bold-ash" ? "post-sync-sha" : "abc123",
    );
    vi.mocked(getChangedFilesBetween).mockReturnValue(["src/foo.ts", "src/bar.ts"]);

    poll("myproject");

    expect(syncWorktreeToRemote).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(getChangedFilesBetween).toHaveBeenCalledWith(
      "/tmp/wt/myproject/bold-ash", "pre-review-sha", "post-sync-sha",
    );
    const mergedCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "merged",
    );
    expect(mergedCall).toBeDefined();
    expect(mergedCall![2]).toMatchObject({
      pendingContinueChangedFiles: ["src/foo.ts", "src/bar.ts"],
      preReviewSha: undefined,
    });
    expect((mergedCall![2] as Record<string, unknown>).pendingContinueSyncFailed).toBeUndefined();
  });

  it("skips diff payload when reviewer made no changes (HEAD unchanged)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "same-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(syncWorktreeToRemote).mockReturnValue({ ok: true });
    vi.mocked(getBranchHeadSha).mockReturnValue("same-sha");

    poll("myproject");

    expect(getChangedFilesBetween).not.toHaveBeenCalled();
    const mergedCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "merged",
    );
    expect((mergedCall![2] as Record<string, unknown>).pendingContinueChangedFiles).toBeUndefined();
  });

  it("alerts and flags syncFailed when worktree is dirty", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(syncWorktreeToRemote).mockReturnValue({ ok: false, reason: "dirty" });

    poll("myproject");

    expect(getChangedFilesBetween).not.toHaveBeenCalled();
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "poller",
        worker: "bold-ash",
        message: expect.stringMatching(/uncommitted changes/),
      }),
    );
    const mergedCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "merged",
    );
    expect(mergedCall![2]).toMatchObject({
      pendingContinueSyncFailed: true,
      preReviewSha: undefined,
    });
  });

  it("skips worktree sync entirely when .garden-done sentinel is set", () => {
    // The .garden-done sentinel always shows as untracked in
    // `git status --porcelain`, so syncing a done worker would always trip
    // the dirty check and fire a misleading alert. Done workers don't need
    // syncing — auto-continue won't fire on them.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(isDoneSet).mockReturnValue(true);

    poll("myproject");

    expect(syncWorktreeToRemote).not.toHaveBeenCalled();
    expect(addAlert).not.toHaveBeenCalled();
    const doneCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "done",
    );
    expect(doneCall).toBeDefined();
    expect((doneCall![2] as Record<string, unknown>).pendingContinueSyncFailed).toBeUndefined();
  });

  it("syncs worktree before deleting the remote branch (refs are shared)", () => {
    // Worktrees share refs with the main repo, so deleteRemoteBranch wipes
    // origin/<branch> from the worktree's ref store too. Sync MUST run first
    // or `git fetch origin <branch>` and `git reset --hard origin/<branch>`
    // both fail, leaving every clean merge with syncFailed=true.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    vi.mocked(syncWorktreeToRemote).mockReturnValue({ ok: true });

    poll("myproject");

    const syncOrder = vi.mocked(syncWorktreeToRemote).mock.invocationCallOrder[0];
    const deleteOrder = vi.mocked(deleteRemoteBranch).mock.invocationCallOrder[0];
    expect(syncOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    expect(syncOrder).toBeLessThan(deleteOrder);
  });

  it("runs postMerge and logs checkout HEAD when fastForwardBase advances", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined, postMerge: "npm run build",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);
    // Simulate the checkout's actual HEAD after fast-forward — not origin/main.
    vi.mocked(getBranchHeadSha).mockImplementation((p: string) =>
      p === "/repo/myproject" ? "deadbeefcafebabe" : "abc123",
    );

    poll("myproject");

    expect(execSync).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ cwd: "/repo/myproject" }),
    );
    // Commit field in the log must come from the checkout's HEAD (short SHA),
    // not origin/<base>. This is the regression guard for the silent stale-build bug.
    expect(log.info).toHaveBeenCalledWith(
      "poller", "postMerge completed",
      expect.objectContaining({ data: expect.objectContaining({ commit: "deadbee" }) }),
    );
    expect(addAlert).not.toHaveBeenCalled();
  });

  it("skips postMerge and alerts when fastForwardBase does not advance", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined, postMerge: "npm run build",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(false);

    poll("myproject");

    // postMerge command must not execute against a stale checkout.
    expect(execSync).not.toHaveBeenCalledWith(
      "npm run build",
      expect.anything(),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringMatching(/did not fast-forward.*postMerge was skipped/),
      }),
    );
    // Worker still reaches merged — the remote merge succeeded, only the
    // local rebuild was deferred.
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged" }),
    );
  });

  it("alerts when fastForwardBase fails even without postMerge configured", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    // Drift of the local checkout is an alertable event regardless of
    // whether a postMerge command exists — stale main rots manual workflow.
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined,
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(false);

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringContaining("did not fast-forward"),
      }),
    );
  });

  it("spawns detached _post-rebuild-refresh after garden self-rebuild", () => {
    registryMock._setEntries("garden", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        worktreePath: "/tmp/wt/garden/bold-ash",
      }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/garden", checks: undefined, postMerge: "npm run build",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue(true);

    poll("garden");

    expect(execSync).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ cwd: "/repo/garden" }),
    );
    const refreshCall = vi.mocked(spawn).mock.calls.find(
      c => String(c[1]?.[1] ?? "").includes("_post-rebuild-refresh"),
    );
    expect(refreshCall).toBeDefined();
    expect(refreshCall![0]).toBe("sh");
    expect(refreshCall![2]).toEqual(expect.objectContaining({ detached: true, stdio: "ignore" }));
  });

  it("launches resolver when rebase has conflicts and Claude is idle", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastReviewBody: "Code looks good.",
        task: "fix the bug",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "conflict" });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre-resolve-sha");

    poll("myproject");

    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToBase).not.toHaveBeenCalled();
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", expect.any(String), "-n", "_myproject-review-bold-ash",
      "-c", "/tmp/wt/myproject/bold-ash", "bash", "-c", expect.any(String),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "resolving",
        reviewWindowName: "_myproject-review-bold-ash",
        preResolveSha: "pre-resolve-sha",
        resolveAttempts: 1,
      }),
    );
  });

  it("escalates to failing when resolver budget is exhausted", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        resolveAttempts: 2, // budget already consumed
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "conflict" });
    vi.mocked(getUnmergedFiles).mockReturnValue(["src/foo.ts", "src/bar.ts"]);

    poll("myproject");

    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    // No new resolver window launched
    expect(tmux).not.toHaveBeenCalledWith(
      "new-window", expect.anything(), expect.anything(), expect.anything(),
      "-n", "_myproject-review-bold-ash",
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        mergePendingAt: undefined,
      }),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringContaining("src/foo.ts"),
      }),
    );
  });

  it("skips resolver launch when rebase conflicts and Claude is working", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "working",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "conflict" });

    poll("myproject");

    expect(rebaseBranch).toHaveBeenCalled();
    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToBase).not.toHaveBeenCalled();
    expect(tmux).not.toHaveBeenCalledWith(
      "new-window", expect.anything(), expect.anything(), expect.anything(),
      "-n", "_myproject-review-bold-ash",
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("clears leftover rebase state before attempting rebase", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);

    poll("myproject");

    expect(ensureNoRebaseInProgress).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
  });

  it("alerts operator and transitions to failing on non-conflict rebase error", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "error", error: "fatal: boom" });

    poll("myproject");

    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToBase).not.toHaveBeenCalled();
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringContaining("fatal: boom"),
      }),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        mergePendingAt: undefined,
      }),
    );
  });

  it("includes previous review body and worker task in resolver prompt", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        claudeStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastReviewBody: "Code is well structured.",
        task: "add retry logic",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "conflict" });

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(promptCall).toBeDefined();
    const promptContent = String(promptCall![1]);
    expect(promptContent).toContain("resolving a rebase conflict");
    expect(promptContent).toContain("Code is well structured.");
    expect(promptContent).toContain("add retry logic");
    expect(promptContent).toContain("Do **not** push");
  });

  it("merges earliest merge-pending first", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "calm-bay",
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 2000).toISOString(),
        sessionId: "s1",
        task: "t1",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
      makeWorker({
        name: "bold-ash",
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        sessionId: "s2",
        task: "t2",
      }),
    ]);

    poll("myproject");

    const mergeCalls = vi.mocked(mergeToBase).mock.calls;
    expect(mergeCalls[0]).toEqual(["/repo/myproject", "calm-bay", "main"]);
  });

  it("resets to working when force-push fails", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(forcePushBranch).mockImplementation(() => { throw new Error("push failed"); });

    poll("myproject");

    expect(mergeToBase).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working", mergePendingAt: undefined }),
    );
  });

  it("adds alert on merge failure and sets pendingReviewAt for re-review", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(mergeToBase).mockImplementation(() => { throw new Error("merge conflict"); });

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        message: expect.stringContaining("Merge failed"),
      }),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        mergePendingAt: undefined,
      }),
    );
    // Must schedule a delayed poke so the poller picks up the re-review
    expect(spawn).toHaveBeenCalledWith(
      "bash",
      ["-c", expect.stringContaining("sleep")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });
});

describe("poll — resolving state", () => {
  function setupResolver(
    overrides: Partial<import("../src/dashboard/registry.js").WorkerEntry> = {},
  ): void {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "resolving",
        reviewWindowName: "_myproject-review-bold-ash",
        preResolveSha: "pre-sha",
        resolveAttempts: 1,
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastSeenSha: "origin-baseline",
        ...overrides,
      }),
    ]);
    // Default: resolver has exited (its window is gone).
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Rebased cleanly.\nDONE";
      return "{}";
    });
    // Align origin tracking ref with the baseline so the worker-push branch
    // does not fire by accident; tests that want to simulate a worker push
    // override this explicitly.
    vi.mocked(getRemoteTrackingSha).mockReturnValue("origin-baseline");
  }

  it("returns false while resolver window is still running", () => {
    setupResolver();
    vi.mocked(windowExists).mockReturnValue(true); // resolver still in-flight

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("transitions to merge-pending when DONE and verification passes", () => {
    setupResolver();
    vi.mocked(getBranchHeadSha).mockReturnValue("post-rebase-sha"); // differs from preResolveSha
    vi.mocked(isAncestor).mockReturnValue(true);
    vi.mocked(hasRebaseInProgress).mockReturnValue(false);

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "merge-pending",
        reviewWindowName: undefined,
      }),
    );
    // Queues the next merge-queue attempt
    expect(spawn).toHaveBeenCalledWith(
      "bash",
      ["-c", expect.stringContaining("sleep 0")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("retries when resolver says DONE but rebase is still in progress", () => {
    setupResolver();
    vi.mocked(getBranchHeadSha).mockReturnValue("post-rebase-sha");
    vi.mocked(hasRebaseInProgress).mockReturnValue(true); // lying — rebase not finished

    poll("myproject");

    // Must abort leftover rebase and bounce back to merge-pending (budget has
    // one attempt left, so no escalation yet).
    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "merge-pending",
        reviewWindowName: undefined,
      }),
    );
  });

  it("retries when resolver says DONE but base is not an ancestor of HEAD", () => {
    setupResolver();
    vi.mocked(getBranchHeadSha).mockReturnValue("post-rebase-sha");
    vi.mocked(isAncestor).mockReturnValue(false); // rebase never happened

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
  });

  it("retries when resolver says DONE but HEAD did not change from preResolveSha", () => {
    setupResolver();
    vi.mocked(getBranchHeadSha).mockReturnValue("pre-sha"); // same as preResolveSha

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
  });

  it("retries when resolver verdict is FAILED", () => {
    setupResolver();
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Conflict is contradictory.\nFAILED";
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("post-sha");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
  });

  it("escalates to failing with conflict files in alert when budget is exhausted", () => {
    setupResolver({ resolveAttempts: 2 }); // at budget
    vi.mocked(isAncestor).mockReturnValue(false); // verification fails
    vi.mocked(getUnmergedFiles).mockReturnValue(["src/auth.ts"]);
    vi.mocked(getBranchHeadSha).mockReturnValue("post-sha");

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        mergePendingAt: undefined,
      }),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        worker: "bold-ash",
        message: expect.stringContaining("src/auth.ts"),
      }),
    );
  });

  it("stores resolver body when it parses even if verification fails", () => {
    setupResolver();
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Tried to rebase.\nFAILED";
      return "{}";
    });

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ lastResolveBody: "Tried to rebase." }),
    );
  });

  it("worker push during resolving resets to working and clears budget", () => {
    setupResolver({ lastSeenSha: "origin-baseline" });
    vi.mocked(getRemoteTrackingSha).mockReturnValue("worker-pushed-sha");
    vi.mocked(getCommitSummary).mockReturnValue("abc123 new worker commit");

    poll("myproject");

    const resetCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "working",
    );
    expect(resetCall).toBeDefined();
    const fields = resetCall![2] as Record<string, unknown>;
    expect(fields.resolveAttempts).toBe(0);
    expect(fields.preResolveSha).toBeUndefined();
    expect(fields.pendingReviewAt).toEqual(expect.any(Number));
    expect(forcePushBranch).not.toHaveBeenCalled();
  });

  it("does not process resolver output while the window is still alive", () => {
    setupResolver();
    vi.mocked(windowExists).mockReturnValue(true); // still alive
    vi.mocked(getRemoteTrackingSha).mockReturnValue("mid-rebase-push"); // reviewer pushed mid-session

    poll("myproject");

    // Neither reset-to-working nor verify-and-merge should fire.
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(forcePushBranch).not.toHaveBeenCalled();
  });
});

describe("poll — reviewer prompt", () => {
  function setupForReview() {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "idle", pendingReviewAt: Date.now() }),
    ]);
  }

  it("rebases onto origin, not the local base ref", () => {
    setupForReview();

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(promptCall).toBeDefined();
    expect(String(promptCall![1])).toContain("git rebase origin/main");
    expect(String(promptCall![1])).not.toMatch(/git rebase main\b/);
  });

  it("includes checks command when configured", () => {
    setupForReview();
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: "npm test",
    } as ReturnType<typeof tryGetProject>);

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    const content = String(promptCall![1]);
    expect(content).toContain("npm test");
    expect(content).toContain("Run checks");
  });

  it("omits checks step when not configured", () => {
    setupForReview();
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: undefined,
    } as ReturnType<typeof tryGetProject>);

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(String(promptCall![1])).not.toContain("Run checks");
  });

  it("includes worker task in prompt", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", claudeStatus: "idle",
        pendingReviewAt: Date.now(), task: "refactor the dashboard" }),
    ]);

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(String(promptCall![1])).toContain("refactor the dashboard");
  });

  it("injects the spec warning when the diff modifies a spec file", () => {
    setupForReview();
    vi.mocked(getChangedFiles).mockReturnValue(["src/dashboard/STATUS.md"]);
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (String(p).endsWith("STATUS.md")) {
        return "# Spec\n\nIf the code disagrees with this document, the code is wrong.";
      }
      return "{}";
    }) as typeof fs.readFileSync);

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    const content = String(promptCall![1]);
    expect(content).toContain("Specification files in this diff");
    expect(content).toContain("src/dashboard/STATUS.md");
    expect(content).toContain("Do not revert spec changes to match the current implementation");
  });

  it("omits the spec warning when no spec files are in the diff", () => {
    setupForReview();
    vi.mocked(getChangedFiles).mockReturnValue(["src/foo.ts", "test/foo.test.ts"]);

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(String(promptCall![1])).not.toContain("Specification files in this diff");
  });

  it("does not treat a markdown file without the marker as a spec", () => {
    setupForReview();
    vi.mocked(getChangedFiles).mockReturnValue(["README.md"]);
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (String(p).endsWith("README.md")) {
        return "# Project Readme\n\nThis is a normal readme without spec markers.";
      }
      return "{}";
    }) as typeof fs.readFileSync);

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(String(promptCall![1])).not.toContain("Specification files in this diff");
  });

  it("scopes the doc-accuracy bullet to descriptive docs only", () => {
    setupForReview();

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    const content = String(promptCall![1]);
    expect(content).toContain("only* to descriptive documents");
    expect(content).toContain("Specs drive the code; do not edit them to match code");
  });
});

describe("poll — failing state", () => {
  it("resets debounce when SHA changes", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingSha: "old-sha",
        lastSeenSha: "old-sha",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll("myproject");

    expect(getNewCommitSummary).toHaveBeenCalledWith(
      "/tmp/wt/myproject/bold-ash", "old-sha",
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      lastSeenSha: "new-sha",
      lastShaChangeAt: expect.any(String),
    });
  });

  it("schedules a delayed FIFO poke when SHA changes", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingSha: "old-sha",
        lastSeenSha: "old-sha",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll("myproject");

    expect(spawn).toHaveBeenCalledWith(
      "bash",
      ["-c", expect.stringContaining("sleep 30")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("stays in failing after debounce when failingSha matches (requires new commits)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingSha: "abc123",
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("abc123");

    poll("myproject");

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("transitions back to working after debounce for transient failures", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("abc123");

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "working",
      failingSha: undefined,
      lastSeenSha: undefined,
    });
  });

  it("stays in failing if debounce not elapsed", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date().toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("abc123");

    poll("myproject");

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});

describe("poll — merged state", () => {
  it("stays merged when no new commits", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merged",
        mergedAt: new Date().toISOString(),
      }),
    ]);
    vi.mocked(getCommitSummary).mockReturnValue("");

    poll("myproject");

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("transitions to working when new commits appear after merge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merged",
        mergedAt: new Date().toISOString(),
      }),
    ]);
    vi.mocked(getCommitSummary).mockReturnValue("def456 add new feature");

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working" }),
    );
  });
});

describe("postPush", () => {
  it("is a simple trigger", () => {
    expect(() => postPush()).not.toThrow();
  });
});

describe("poll — sibling merge notification", () => {
  it("notifies sibling worker when files overlap after merge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        sessionId: "s1",
        task: "t1",
        worktreePath: "/tmp/wt/myproject/bold-ash",
        branchName: "bold-ash",
      }),
      makeWorker({
        name: "calm-bay",
        prState: "working",
        claudeStatus: "idle", // alive
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce(["src/foo.ts", "src/bar.ts"])  // merged worker
      .mockReturnValueOnce(["src/foo.ts", "src/baz.ts"]); // sibling

    poll("myproject");

    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5", "-l",
      expect.stringContaining("src/foo.ts"),
    );
  });

  it("does not notify sibling when no file overlap", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        sessionId: "s1",
        task: "t1",
        worktreePath: "/tmp/wt/myproject/bold-ash",
        branchName: "bold-ash",
      }),
      makeWorker({
        name: "calm-bay",
        prState: "working",
        claudeStatus: "idle",
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce(["src/foo.ts"])
      .mockReturnValueOnce(["src/bar.ts"]);

    poll("myproject");

    expect(mergeToBase).toHaveBeenCalled();
    const sendKeyCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "send-keys" && typeof c[3] === "string" && c[3].includes("overlap"),
    );
    expect(sendKeyCalls).toHaveLength(0);
  });

  it("skips dead sibling (claudeStatus=exited)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        sessionId: "s1",
        task: "t1",
        worktreePath: "/tmp/wt/myproject/bold-ash",
        branchName: "bold-ash",
      }),
      makeWorker({
        name: "calm-bay",
        prState: "working",
        claudeStatus: "exited",
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce(["src/foo.ts"])
      .mockReturnValueOnce(["src/foo.ts"]);

    poll("myproject");

    // Should NOT have sent any send-keys to the dead sibling
    const sendKeyCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "send-keys",
    );
    expect(sendKeyCalls).toHaveLength(0);
  });

  it("skips notification for workers in merged state", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        sessionId: "s1",
        task: "t1",
        worktreePath: "/tmp/wt/myproject/bold-ash",
        branchName: "bold-ash",
      }),
      makeWorker({
        name: "calm-bay",
        prState: "merged",
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(getChangedFiles).mockReturnValue(["src/foo.ts"]);
    vi.mocked(getCommitSummary).mockImplementation((wtPath: string) => {
      if (wtPath.includes("calm-bay")) return "";
      return "abc123 fix something";
    });

    poll("myproject");

    const changedFilesCalls = vi.mocked(getChangedFiles).mock.calls;
    const calmBayCalls = changedFilesCalls.filter(c => c[0] === "/tmp/wt/myproject/calm-bay");
    expect(calmBayCalls).toHaveLength(0);
  });
});

describe("poll — alerts", () => {
  it("adds alert after 3 repeated failures", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failCount: 3,
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("abc123");

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("failed 3 times"),
      }),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "working",
      failingSha: undefined,
      lastSeenSha: undefined,
    });
  });

  it("does not add repeated-failure alert below threshold", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failCount: 2,
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("abc123");

    poll("myproject");

    expect(addAlert).not.toHaveBeenCalled();
  });

  it("resets failCount on successful merge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        failCount: 2,
      }),
    ]);

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged", failCount: 0 }),
    );
  });

  it("increments failCount when reviewer cannot fix issues", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        claudeStatus: "idle",
        failCount: 1,
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Fundamental issue.\nFAILED";
      return "{}";
    });

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing", failCount: 2 }),
    );
  });
});

describe("restartLongLivedPollers", () => {
  beforeEach(() => {
    // start*Poller early-returns when the window already exists. In the real
    // flow, stop*Poller has already killed it; here the mock doesn't know
    // about that linkage, so we pretend the windows are gone so the spawn
    // side of restart runs.
    vi.mocked(windowExists).mockReturnValue(false);
  });

  it("stops and respawns the usage poller", () => {
    restartLongLivedPollers("node /usr/local/bin/garden");

    expect(killWindowSafe).toHaveBeenCalledWith("_garden-usage-poller");
    const newWindowCalls = vi.mocked(tmux).mock.calls.filter(c => c[0] === "new-window");
    const windowNames = newWindowCalls.map(c => c[5] as string);
    expect(windowNames).toContain("_garden-usage-poller");
  });

  it("restarts every project poller whose registry has live workers", () => {
    registryMock._setEntries("alpha", [makeWorker({ name: "bold-ash" })]);
    registryMock._setEntries("beta",  [makeWorker({ name: "hot-moss" })]);

    restartLongLivedPollers("node /usr/local/bin/garden");

    expect(killWindowSafe).toHaveBeenCalledWith("_alpha-poller");
    expect(killWindowSafe).toHaveBeenCalledWith("_beta-poller");

    const newWindowCalls = vi.mocked(tmux).mock.calls.filter(c => c[0] === "new-window");
    const windowNames = newWindowCalls.map(c => c[5] as string);
    expect(windowNames).toContain("_alpha-poller");
    expect(windowNames).toContain("_beta-poller");
  });

  it("skips projects that have no live workers", () => {
    registryMock._setEntries("alpha", []);

    restartLongLivedPollers("node /usr/local/bin/garden");

    expect(killWindowSafe).not.toHaveBeenCalledWith("_alpha-poller");
  });

  it("keeps going when an individual poller restart throws", () => {
    registryMock._setEntries("alpha", [makeWorker({ name: "bold-ash" })]);
    registryMock._setEntries("beta",  [makeWorker({ name: "hot-moss" })]);
    // usage-poller kill succeeds; throw on alpha so beta still gets restarted.
    vi.mocked(killWindowSafe).mockImplementation((name: string) => {
      if (name === "_alpha-poller") throw new Error("tmux gone");
    });

    expect(() => restartLongLivedPollers("node /usr/local/bin/garden")).not.toThrow();
    expect(killWindowSafe).toHaveBeenCalledWith("_beta-poller");
  });
});
