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
  loadConfig: vi.fn(() => ({ projects: { myproject: { path: "/repo/myproject" } } })),
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
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
  rebaseBranch: vi.fn(() => "ok"),
  abortRebase: vi.fn(),
  cleanWorktree: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  fastForwardBase: vi.fn(),
  getChangedFiles: vi.fn(() => []),
  getCommitSummary: vi.fn(() => "abc123 fix something"),
  getNewCommitSummary: vi.fn(() => "def456 address review feedback"),
  resolveBaseBranch: vi.fn(() => "main"),
  ensureNoRebaseInProgress: vi.fn(),
  hasRebaseInProgress: vi.fn(() => false),
  isAncestor: vi.fn(() => true),
  getUnmergedFiles: vi.fn(() => []),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "test rules"),
}));

import fs from "node:fs";
import { poll, postPush } from "../src/dashboard/poller.js";
import { tryGetProject } from "../src/config.js";
import { updateWorkerFields, findWorkerByName } from "../src/dashboard/registry.js";
import {
  getBranchHeadSha, getRemoteTrackingSha, deleteRemoteBranch,
  forcePushBranch, mergeToBase, rebaseBranch, abortRebase,
  fastForwardBase,
  getChangedFiles, getCommitSummary, getNewCommitSummary, getDiffAgainstBase,
  ensureNoRebaseInProgress, hasRebaseInProgress, isAncestor, getUnmergedFiles,
} from "../src/dashboard/git.js";
import { tmux, windowExists, getFirstPaneId } from "../src/dashboard/tmux.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { log } from "../src/dashboard/log.js";
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
  vi.mocked(rebaseBranch).mockReturnValue("ok");
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

    expect(fs.writeFileSync).toHaveBeenCalled();
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
    vi.mocked(rebaseBranch).mockReturnValue("ok");
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
    vi.mocked(rebaseBranch).mockReturnValue("ok");
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
    vi.mocked(rebaseBranch).mockReturnValue("ok");
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
    vi.mocked(rebaseBranch).mockReturnValue("ok");
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
    vi.mocked(rebaseBranch).mockReturnValue("conflict");
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
    vi.mocked(rebaseBranch).mockReturnValue("conflict");
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
    vi.mocked(rebaseBranch).mockReturnValue("conflict");

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

  it("alerts operator on non-conflict rebase error", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue("error");

    poll("myproject");

    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToBase).not.toHaveBeenCalled();
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
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
    vi.mocked(rebaseBranch).mockReturnValue("conflict");

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

  it("includes rebase instructions", () => {
    setupForReview();

    poll("myproject");

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(promptCall).toBeDefined();
    expect(String(promptCall![1])).toContain("git rebase main");
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
