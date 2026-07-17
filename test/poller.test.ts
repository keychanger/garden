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
  tryResolveProvider: vi.fn(() => null),
  anyAnthropicMeteredProject: vi.fn(() => true),
  ENV_VAR_NAME_RE: /^[A-Z_][A-Z0-9_]*$/,
  loadConfig: vi.fn(() => ({ projects: { myproject: { path: "/repo/myproject" } } })),
  SESSIONS_DIR: "/tmp/fake-sessions",
  GARDEN_DIR: "/tmp/fake-garden",
  getMaxConcurrentReviews: vi.fn(() => 0),
  getAutoContinueConfig: vi.fn(() => ({
    enabled: true, usageThreshold: 95, resumeAfterReset: false,
  })),
  setAutoContinueConfig: vi.fn((patch) => ({
    enabled: true, usageThreshold: 95, resumeAfterReset: false, ...patch,
  })),
}));

vi.mock("../src/dashboard/usage.js", () => ({
  readUsageSnapshot: vi.fn(() => null),
  // Mirror the real accessor's null-snapshot behavior: no data, no meters.
  snapshotMeters: vi.fn(() => []),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Spy on the review-family telemetry writes so tests can assert an outcome is
// (or is not) ledgered; the rest of the module stays real (writes swallow under
// the fs mock, which has no appendFileSync — best-effort, exactly as in prod).
vi.mock("../src/dashboard/telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dashboard/telemetry.js")>()),
  recordReviewVerdict: vi.fn(),
  recordResolveOutcome: vi.fn(),
  recordCiFixOutcome: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  setupStatusBar: vi.fn(),
}));

vi.mock("../src/dashboard/hotkeys.js", () => ({
  setupKeybindings: vi.fn(),
}));

vi.mock("../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "node /usr/local/bin/garden"),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  newDashboardWindow: vi.fn(),
  pasteAndSubmit: vi.fn(),
  getFirstPaneId: vi.fn(() => "%5"),
  windowExists: vi.fn(() => true),
  windowIndices: vi.fn(() => [1]),
  listAllWindowNames: vi.fn(() => []),
  killWindowSafe: vi.fn(),
  killWindowsByName: vi.fn(),
  dedupeWindows: vi.fn(() => 0),
  // Mirror the real shellEscape: pass safe-token strings through unquoted,
  // wrap others in single quotes with the inner-quote escape. headless-agent
  // and poller-* import it for bash command construction.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  ),
}));

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    OPERATOR_ACTION_FAILING_REASONS: new Set(["trellis-flagged", "iteration-budget", "stagnation"]),
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
  // poll() calls this on every cycle; without the mock the call throws
  // TypeError and gets silently swallowed by poll()'s try/catch, masking
  // wiring regressions. Default to false (no ghosts swept) so
  // refreshDashboard isn't invoked unless a test opts in.
  sweepGhostEntries: vi.fn(() => false),
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
  fastForwardBase: vi.fn(() => ({ ok: true, advanced: "worktree" })),
  getChangedFiles: vi.fn(() => []),
  getChangedFilesBetween: vi.fn(() => []),
  getDiffNumstat: vi.fn(() => ({ files: 0, insertions: 0, deletions: 0 })),
  getCommitSummary: vi.fn(() => "abc123 fix something"),
  hasCommitsAhead: vi.fn(() => true),
  getNewCommitSummary: vi.fn(() => "def456 address review feedback"),
  resolveBaseBranch: vi.fn(() => "main"),
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
  syncWorktreeToRemote: vi.fn(() => ({ ok: true })),
  ensureNoRebaseInProgress: vi.fn(),
  hasRebaseInProgress: vi.fn(() => false),
  // Two callers, opposite argument orders. The resolver checks "is base an
  // ancestor of HEAD" (rebased onto base → true). handleMergePending's resume
  // check asks "is HEAD an ancestor of origin/<base>" (merge already landed).
  // Default the resume check to false (a worker about to merge has unmerged
  // commits) by keying off the remote ref appearing as the descendant.
  isAncestor: vi.fn((_wt: string, _ancestor: string, descendant: string) =>
    !String(descendant).startsWith("origin/")),
  getUnmergedFiles: vi.fn(() => []),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "test rules"),
}));

// The Haiku verdict-extraction fallback runs (default workflow) before the
// unparseable-verdict re-review paths. Default it to "no verdict recovered" so
// the existing unparseable-path tests exercise the fall-through; individual
// tests override the return to cover the recovery path.
vi.mock("../src/dashboard/verdict-extract.js", () => ({
  extractReviewVerdict: vi.fn(() => null),
}));

vi.mock("../src/dashboard/poller-ci.js", () => ({
  // Default: no github remote → gate is a pass-through. Individual tests
  // override these to exercise the success/pending/failed/unavailable paths.
  getGitHubRepoSlug: vi.fn(() => null),
  checkCiStatus: vi.fn(() => ({ kind: "success" })),
}));

vi.mock("../src/dashboard/continue.js", () => ({
  dispatchDelayedAutoContinue: vi.fn(),
  dispatchDelayedContinue: vi.fn(),
  continueWorker: vi.fn(),
  continueWorkerAfterMerge: vi.fn(),
  isDoneSet: vi.fn(() => false),
  donePath: vi.fn((wt: string) => `${wt}/.garden-done`),
  clearDoneSentinel: vi.fn(),
  setDoneSentinel: vi.fn(),
}));

// Stub scheduleDelayedPoke (detached `bash -c "sleep N; printf … 1<>FIFO"`)
// and triggerProjectPoll (non-blocking FIFO write) so tests can assert "the
// poller scheduled a re-poke" without spawning real subprocesses. Other
// exports are kept real because callers (e.g. isWorkerClaudeWorking in
// poller-resolve gating) read the registry-mocked entry shape and tests rely
// on that behavior.
vi.mock("../src/dashboard/poller-fifo.js", async () => {
  const actual = await vi.importActual<typeof import("../src/dashboard/poller-fifo.js")>(
    "../src/dashboard/poller-fifo.js",
  );
  return {
    ...actual,
    triggerProjectPoll: vi.fn(),
    scheduleDelayedPoke: vi.fn(),
    ensureSignalFifo: vi.fn(() => true),
  };
});

import fs from "node:fs";
import { poll, postPush, restartLongLivedPollers, startProjectPoller } from "../src/dashboard/poller.js";
import { __resetFfStateForTest, _resetGateBlockThrottleForTest } from "../src/dashboard/poller-merge.js";
import { tryGetProject, getAutoContinueConfig, getMaxConcurrentReviews } from "../src/config.js";
import { updateWorkerFields, findWorkerByName } from "../src/dashboard/registry.js";
import {
  getBranchHeadSha, getRemoteTrackingSha, deleteRemoteBranch,
  forcePushBranch, mergeToBase, rebaseBranch, abortRebase, cleanWorktree,
  fastForwardBase,
  getChangedFiles, getChangedFilesBetween,
  getCommitSummary, hasCommitsAhead, getNewCommitSummary, getDiffAgainstBase,
  syncWorktreeToRemote,
  ensureNoRebaseInProgress, hasRebaseInProgress, isAncestor, getUnmergedFiles,
} from "../src/dashboard/git.js";
import { tmux, newDashboardWindow, pasteAndSubmit, windowExists, windowIndices, dedupeWindows, getFirstPaneId, killWindowSafe, killWindowsByName, listAllWindowNames } from "../src/dashboard/tmux.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { log } from "../src/dashboard/log.js";
import { dispatchDelayedAutoContinue, isDoneSet, setDoneSentinel } from "../src/dashboard/continue.js";
import { scheduleDelayedPoke } from "../src/dashboard/poller-fifo.js";
import { getGitHubRepoSlug, checkCiStatus } from "../src/dashboard/poller-ci.js";
import { sweepGhostEntries } from "../src/dashboard/validate.js";
import { refreshDashboard } from "../src/dashboard/header.js";
import { recordCiFixOutcome } from "../src/dashboard/telemetry.js";
import { extractReviewVerdict } from "../src/dashboard/verdict-extract.js";
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
  __resetFfStateForTest();
  // Re-establish factory defaults after reset
  vi.mocked(windowExists).mockReturnValue(true);
  // Review cap defaults to unlimited with no live reviewer windows, so the
  // fleet-wide gate is inert unless a test opts in.
  vi.mocked(getMaxConcurrentReviews).mockReturnValue(0);
  vi.mocked(listAllWindowNames).mockReturnValue([]);
  vi.mocked(getFirstPaneId).mockReturnValue("%5");
  vi.mocked(getChangedFiles).mockReturnValue([]);
  vi.mocked(getDiffAgainstBase).mockReturnValue("diff --git a/file.ts b/file.ts");
  vi.mocked(getCommitSummary).mockReturnValue("abc123 fix something");
  vi.mocked(hasCommitsAhead).mockReturnValue(true);
  vi.mocked(getNewCommitSummary).mockReturnValue("def456 address review feedback");
  vi.mocked(sweepGhostEntries).mockReturnValue(false);
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: undefined } as ReturnType<typeof tryGetProject>);
  vi.mocked(getBranchHeadSha).mockReturnValue("abc123");
  vi.mocked(getRemoteTrackingSha).mockReturnValue("abc123");
  vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
  vi.mocked(hasRebaseInProgress).mockReturnValue(false);
  vi.mocked(isAncestor).mockImplementation((_wt, _ancestor, descendant) =>
    !String(descendant).startsWith("origin/"));
  vi.mocked(getUnmergedFiles).mockReturnValue([]);
  vi.mocked(fs.existsSync).mockReturnValue(false);
  // Default the Haiku verdict-extraction fallback to "no verdict recovered"
  // (resetAllMocks wiped the factory impl to undefined). The unparseable-path
  // tests rely on this; the recovery test overrides it.
  vi.mocked(extractReviewVerdict).mockReturnValue(null);
});

// In the new model, review is launched when pendingReviewAt is set on the
// worker. Per STATUS.md invariant 2, working→reviewing requires the Stop
// hook to fire with new commits — and the Stop hook is the only place that
// sets pendingReviewAt. Idle workers without pendingReviewAt are NOT
// candidates for review even if they have stale commits ahead of base.
describe("poll — working state", () => {
  it("launches review when pendingReviewAt is set and commits exist", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    // The prompt file path matches the convention in poller.ts:87
    // (`${project}-${worker}-review-prompt.txt`). Bare toHaveBeenCalled would
    // pass even if writeFileSync wrote garbage to a wrong path.
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("myproject-bold-ash-review-prompt.txt"),
      expect.any(String),
    );
    expect(newDashboardWindow).toHaveBeenCalledWith(
      "_myproject-review-bold-ash",
      "-c", "/tmp/wt/myproject/bold-ash", "bash", "-c", expect.any(String),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
      }),
    );
  });

  it("clears a leaked holistic final-review marker on a fresh per-phase review launch", () => {
    // A prior holistic FIX that reached merge-pending but then failed to merge
    // (resolver/ci-fix budget exhausted, wedged merge) parks the worker in
    // `failing` with holisticFinalActive still set — none of those merge-side
    // failing transitions clear it, and failing -> working doesn't either. When
    // the worker recovers and a fresh per-phase review launches here, the marker
    // must be cleared: otherwise handleReviewing would misroute this review to
    // handleHolisticFinalReview, which finalizes a CLEAN verdict to `done`
    // WITHOUT merging the recovery commits (they'd strand unmerged under a
    // false green done). A per-phase review launched via launchReview is never
    // the interposed holistic pass, so clearing the markers is always correct.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working", agentStatus: "idle", pendingReviewAt: Date.now(),
        holisticFinalActive: true, holisticReviewMode: "fix",
      }),
    ]);

    poll("myproject");

    const call = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "reviewing",
    );
    expect(call).toBeDefined();
    const fields = call![2] as Record<string, unknown>;
    // The key must be present-and-undefined (an explicit clear), not merely absent.
    expect("holisticFinalActive" in fields).toBe(true);
    expect(fields.holisticFinalActive).toBeUndefined();
    expect(fields.holisticReviewMode).toBeUndefined();
  });

  it("does NOT review an idle worker without pendingReviewAt (the regression)", () => {
    // This is the spec invariant 2 case: a worker may be idle with stale
    // commits ahead of base for any reason — Q&A session, abandoned branch,
    // resume-after-restart. Without pendingReviewAt set by the Stop hook,
    // we MUST NOT launch a review on it.
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle" }),
    ]);
    // Commits ahead of base, but no pendingReviewAt
    vi.mocked(getCommitSummary).mockReturnValue("abc123 some old commit");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(newDashboardWindow).not.toHaveBeenCalledWith(
      expect.stringContaining("review"),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("does nothing when agentStatus is working (Claude still active)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "working", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
  });

  it("defers review launch when agentStatus=working with a fresh lastEventAt", () => {
    // Normal mid-turn race: Claude is actively working and emitted a hook
    // recently. Don't launch the review — wait for the next Stop hook.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working",
        agentStatus: "working",
        pendingReviewAt: Date.now(),
        lastEventAt: Date.now() - 30_000, // 30s ago: fresh
      }),
    ]);

    poll("myproject");

    expect(newDashboardWindow).not.toHaveBeenCalledWith(
      expect.stringContaining("review"),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("proceeds with review launch when agentStatus=working is stale (>15min lastEventAt)", () => {
    // Hung-Claude case: status is pinned to "working" but no hook has fired
    // in over 15 minutes. Without this escape hatch, `garden kick` on a
    // failing worker whose Claude hung would never actually start the review.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working",
        agentStatus: "working",
        pendingReviewAt: Date.now(),
        lastEventAt: Date.now() - 20 * 60 * 1000, // 20min ago: stale
      }),
    ]);

    poll("myproject");

    // Review window is launched even though agentStatus says "working".
    expect(newDashboardWindow).toHaveBeenCalledWith(
      "_myproject-review-bold-ash",
      "-c", "/tmp/wt/myproject/bold-ash", "bash", "-c", expect.any(String),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });

  it("does not treat agentStatus=working as stale when lastEventAt is undefined", () => {
    // Legacy entries without lastEventAt should fall through to today's
    // behavior (defer). Treating undefined as "infinitely stale" would
    // launch reviews against genuinely active workers that pre-date the
    // lastEventAt field.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working",
        agentStatus: "working",
        pendingReviewAt: Date.now(),
        // lastEventAt deliberately undefined
      }),
    ]);

    poll("myproject");

    expect(newDashboardWindow).not.toHaveBeenCalledWith(
      expect.stringContaining("review"),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("defers review launch when reviewRetryAt is in the future (transient backoff)", () => {
    // handleTransientReviewFailure schedules a delayed poke at reviewRetryAt,
    // but sibling FIFO pokes (another worker's Stop hook, kick, etc.) can
    // wake the poller earlier. handleWorking must honor the backoff and
    // re-schedule, not launch the review immediately.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working",
        agentStatus: "idle",
        pendingReviewAt: Date.now(),
        reviewRetryCount: 1,
        reviewRetryAt: Date.now() + 60_000, // 60s in the future
      }),
    ]);

    poll("myproject");

    // No review window launched.
    expect(newDashboardWindow).not.toHaveBeenCalledWith(
      expect.stringContaining("review"),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
    // Re-schedules a delayed poke for the remaining time.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", expect.any(Number));
  });

  it("clears pendingReviewAt when commits no longer exist", () => {
    // Stop hook said commits existed; by the time the poller wakes, they're
    // gone (force-pushed away, base advanced past them, etc.). Clear the
    // flag so we don't keep retrying.
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);
    vi.mocked(hasCommitsAhead).mockReturnValue(false);

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ pendingReviewAt: undefined }),
    );
    expect(forcePushBranch).not.toHaveBeenCalled();
    // No review launched: clearing and launching both null pendingReviewAt, so
    // the assertion above cannot tell them apart — pin down that the false
    // branch clears and stops rather than falling through to launchReview,
    // which is the one path that transitions to "reviewing".
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });

  it("does NOT clear pendingReviewAt when the commit check errors (transient git failure)", () => {
    // hasCommitsAhead returns null when the git call itself failed. Treating
    // that as "no commits" would silently cancel a review that should still
    // run. Leave pendingReviewAt set and re-poke to retry.
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);
    vi.mocked(hasCommitsAhead).mockReturnValue(null);

    poll("myproject");

    // pendingReviewAt must NOT be cleared.
    const clearedPending = vi.mocked(updateWorkerFields).mock.calls.some(
      ([, , fields]) => (fields as { pendingReviewAt?: unknown }).pendingReviewAt === undefined
        && "pendingReviewAt" in (fields as object),
    );
    expect(clearedPending).toBe(false);
    // And a retry is scheduled.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 30_000);
  });

  it("launchReview clears pendingReviewAt", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
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
      makeWorker({ name: "calm-bay", prState: "reviewing", agentStatus: "idle",
        sessionId: "s1", task: "t1", reviewWindowName: "_myproject-review-calm-bay",
        worktreePath: "/tmp/wt/myproject/calm-bay", branchName: "calm-bay",
        lastSeenSha: "abc123" }),
      makeWorker({ name: "bold-ash", prState: "working", agentStatus: "idle",
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
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    const launchCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "reviewing",
    );
    expect(launchCall).toBeDefined();
    expect((launchCall![2] as Record<string, unknown>).reviewStartedAt).toEqual(expect.any(Number));
    // scheduleReviewTimeoutPoke now delegates to scheduleDelayedPoke, which
    // spawns a detached bash subprocess so the timer survives `_poll`'s exit.
    // The previous in-process `setTimeout(...).unref()` was dropped at exit
    // (Node terminates unref'd timers when the event loop empties) — a hung
    // reviewer never got pinged, the worker wedged in `reviewing`, the merge
    // never happened, and post-merge auto-continue never fired.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 60 * 60 * 1000);
  });

  // Fleet-wide review concurrency cap (garden-level limits.maxConcurrentReviews).
  // When the number of live `-review-` windows across the session already meets
  // the cap, handleWorking defers the launch: no `reviewing` transition, a
  // re-poke is scheduled, and pendingReviewAt is left set so the next poll (or a
  // sibling event freeing a slot) re-drives the launch.
  it("defers a review launch when the fleet review cap is already met", () => {
    vi.mocked(getMaxConcurrentReviews).mockReturnValue(2);
    // Two reviewers already running elsewhere in the fleet — cap reached. The
    // worker window is excluded by the -worker- filter, so it does not count.
    vi.mocked(listAllWindowNames).mockReturnValue([
      "_other-review-calm-bay",
      "_third-review-swift-oak",
      "_myproject-worker-bold-ash",
    ]);
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    const launched = vi.mocked(updateWorkerFields).mock.calls.some(
      c => (c[2] as Record<string, unknown>).prState === "reviewing",
    );
    expect(launched).toBe(false);
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 20_000);
  });

  it("launches under the cap when a review slot is free", () => {
    vi.mocked(getMaxConcurrentReviews).mockReturnValue(2);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-review-calm-bay"]); // 1 < 2
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    const launched = vi.mocked(updateWorkerFields).mock.calls.some(
      c => (c[2] as Record<string, unknown>).prState === "reviewing",
    );
    expect(launched).toBe(true);
  });

  // The review family defaults to explicit strong Anthropic Opus on the
  // claude-code path — operator choice 2026-07 (resolveReviewRole's
  // SAFE_REVIEW_MODEL) — so a cheap/experimental worker is never reviewed
  // cheaply. This holds for BOTH provider-backed and first-party projects; a
  // provider project additionally gets its inherited provider env neutralized
  // so the Opus reviewer never runs on the worker's backend. Overridable per
  // role via `garden config <p> role reviewer ...`.
  it("pins the reviewer to opus and neutralizes provider env for provider projects", async () => {
    const { tryResolveProvider } = await import("../src/config.js");
    vi.mocked(tryResolveProvider).mockReturnValueOnce({
      name: "deepseek", label: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic", authTokenEnv: "DEEPSEEK_API_KEY",
    });
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    const reviewLaunch = vi.mocked(newDashboardWindow).mock.calls.find(
      c => String(c[0]).includes("review"),
    );
    expect(reviewLaunch).toBeDefined();
    expect(String(reviewLaunch![5])).toContain("--model opus");
    // The Opus default no longer depends on a provider probe: resolveReviewRole
    // resolves the reviewer env exactly once (reviewerEnvPrefix ->
    // tryResolveProvider), which the Once stub feeds so the neutralization
    // fires. If this count changes, the stub is feeding the wrong consumer.
    expect(String(reviewLaunch![5])).toContain("ANTHROPIC_BASE_URL=''");
    expect(vi.mocked(tryResolveProvider).mock.calls.length).toBe(1);
  });

  it("defaults the reviewer to opus for first-party projects too", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
    ]);

    poll("myproject");

    const reviewLaunch = vi.mocked(newDashboardWindow).mock.calls.find(
      c => String(c[0]).includes("review"),
    );
    expect(reviewLaunch).toBeDefined();
    // Explicit Opus default now applies to every claude-code review, not just
    // provider-backed projects (operator choice, overridable per role).
    expect(String(reviewLaunch![5])).toContain("--model opus");
  });
});

describe("poll — review/resolve timeout", () => {
  // The cap is `Date.now() - reviewStartedAt > REVIEW_TIMEOUT_MS` (strict >).
  // At exactly 60 minutes the reviewer is NOT yet timed out; at 60 minutes +
  // 1ms it IS. These two boundary tests pin the > vs >= semantics. Keep this
  // in lockstep with REVIEW_TIMEOUT_MS in src/dashboard/poller-review.ts.
  const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
  const PAST_CAP_AGO = Date.now() - REVIEW_TIMEOUT_MS - 60 * 1000;

  it("reviewing → failing when the reviewer exceeds the 60-minute cap", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        reviewStartedAt: PAST_CAP_AGO,
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
        message: expect.stringContaining("60-minute timeout"),
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
        reviewStartedAt: PAST_CAP_AGO,
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
        reviewStartedAt: PAST_CAP_AGO,
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
      c => String((c[0] as { message: string }).message).includes("60-minute timeout"),
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

  it("does NOT time out at exactly 60 minutes (boundary, > cap)", () => {
    // Freeze Date.now so the elapsed = REVIEW_TIMEOUT_MS exactly. Without
    // this, coverage instrumentation slows the run enough that real-clock
    // drift between setup and the poller's `Date.now()` call pushes
    // elapsed > cap and flips the assertion.
    const frozen = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      registryMock._setEntries("myproject", [
        makeWorker({
          prState: "reviewing",
          reviewWindowName: "_myproject-review-bold-ash",
          reviewStartedAt: frozen - REVIEW_TIMEOUT_MS,
          lastSeenSha: "abc123",
        }),
      ]);
      vi.mocked(windowExists).mockReturnValue(true);

      poll("myproject");

      expect(killWindowSafe).not.toHaveBeenCalled();
      const timeoutAlert = vi.mocked(addAlert).mock.calls.find(
        c => String((c[0] as { message: string }).message).includes("60-minute timeout"),
      );
      expect(timeoutAlert).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("times out at 60 minutes + 1ms (boundary, just past cap)", () => {
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
        message: expect.stringContaining("60-minute timeout"),
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
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 0);
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
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 0);
  });

  it("records a durable lastReview snapshot at verdict dispatch", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123", preReviewSha: "pre1234" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).includes("review-result"));
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result") ? "Looks good.\nCLEAN" : "{}");

    poll("myproject");

    const lastReviewCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).lastReview !== undefined,
    );
    expect(lastReviewCall).toBeDefined();
    expect((lastReviewCall![2] as { lastReview: Record<string, unknown> }).lastReview).toMatchObject({
      verdict: "clean",
      preReviewSha: "pre1234",
      at: expect.any(Number),
    });
  });

  it("re-arms and alerts (does not silently strand) when force-push fails after review", () => {
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
    // Re-arm rather than strand: pendingReviewAt set so handleWorking re-reviews
    // (retrying the push), review window cleared.
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        reviewWindowName: undefined,
      }),
    );
    // A delayed poke guarantees the retry even with no other event, and the
    // operator is alerted (deduped) so a persistent failure is visible.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 30_000);
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: "push-failed:myproject:bold-ash" }),
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

  it("retries with backoff when reviewer output ends in API Error: 500", () => {
    // Transient Anthropic API failure — reviewer never produced a verdict
    // because Claude itself was unavailable. Head is unchanged. The poller
    // should NOT transition to failing on the first attempt; it should
    // increment reviewRetryCount, set a backoff timestamp, and schedule a
    // delayed poke.
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
        return "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check status.claude.com.";
      }
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        reviewRetryCount: 1,
        reviewRetryAt: expect.any(Number),
        reviewWindowName: undefined,
      }),
    );
    // Backoff scheduled, not immediate.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 30_000);
    // Worker is not in failing.
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
  });

  it("auto-retries on a long backoff when the reviewer hits the Claude session limit", () => {
    // Quota cutoff (the operator's rolling window), NOT a transient API blip:
    // the reviewer produced no verdict and did not advance HEAD. Auto-retry on
    // the 15-min quota cadence so it self-heals when the window resets, rather
    // than hard-failing into unparseable-verdict.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).includes("review-result"));
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result")
        ? "Reviewing…\nYou've hit your session limit · resets 3:40pm (America/Denver)"
        : "{}");
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456"); // reviewer did NOT advance HEAD

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        quotaRetryCount: 1,
        reviewRetryAt: expect.any(Number),
        reviewWindowName: undefined,
      }),
    );
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 900_000);
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
    // The alert names the reviewer's harness (Claude for the claude-code path)
    // and the extracted reset time, not a hardcoded "Claude ... window".
    const quotaAlert = vi.mocked(addAlert).mock.calls.find(
      c => String((c[0] as { dedupKey?: string }).dedupKey).startsWith("quota-review:"),
    );
    expect(quotaAlert).toBeDefined();
    const quotaMsg = String((quotaAlert![0] as { message: string }).message);
    expect(quotaMsg).toContain("Claude");
    expect(quotaMsg).toContain("3:40pm (America/Denver)");
  });

  it("parks in failing/quota after the quota retry budget is exhausted", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
        quotaRetryCount: 24, // at budget
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).includes("review-result"));
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result") ? "You've hit your session limit · resets 3:40pm" : "{}");
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");

    poll("myproject");

    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    const fields = failingCall![2] as Record<string, unknown>;
    expect(fields.failingReason).toBe("quota");
    expect(fields.quotaRetryCount).toBeUndefined();
  });

  it("dispatches a parsed verdict even when a session-limit line is present (parse-first, not quota)", () => {
    // A real verdict short-circuits BEFORE the quota detector, so a session-limit
    // line above a CLEAN verdict still merges — the detector can never trap a
    // verdict-emitting review.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).includes("review-result"));
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result")
        ? "You've hit your session limit · resets 3pm\nCLEAN"
        : "{}");

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ quotaRetryCount: 1 }),
    );
  });

  it("takes the unparseable recovery (not quota) when the reviewer advanced HEAD before the cutoff", () => {
    // The !advanced guard: if the reviewer committed work before running out,
    // we do NOT relaunch on top of it — it falls through to the unparseable
    // force-push + re-queue path.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).includes("review-result"));
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result") ? "You've hit your session limit · resets 3:40pm" : "{}");
    vi.mocked(getBranchHeadSha).mockReturnValue("post789"); // reviewer advanced HEAD

    poll("myproject");

    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ quotaRetryCount: 1 }),
    );
    const workingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash"
        && (c[2] as Record<string, unknown>).prState === "working"
        && (c[2] as Record<string, unknown>).unparseableReviewAt !== undefined,
    );
    expect(workingCall).toBeDefined();
  });

  it("a quota-retry relaunch does NOT re-increment the trellis iteration counter", () => {
    // A quota cutoff re-queues the SAME iteration through `working` on a flat
    // 15-min ladder (budget 24). launchReview must NOT treat each relaunch as a
    // fresh iteration, or a multi-hour quota wait would inflate trellis.iteration
    // by up to 24 and trip the iteration-budget cap prematurely — parking the
    // vine in the non-kick-recoverable failing/"iteration-budget" instead of the
    // kick-recoverable quota wait it actually is. quotaRetryCount marks the retry.
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "swift-vine",
        prState: "working",
        agentStatus: "idle",
        workflow: "trellis",
        pendingReviewAt: Date.now(),
        quotaRetryCount: 1,
        reviewRetryAt: Date.now() - 1000, // backoff already elapsed
        trellis: { name: "auth", path: "/tmp/auth.md", iteration: 20, maxIterations: 30 },
      }),
    ]);

    poll("myproject");

    // No iteration write of any value: the relaunch reviews iteration 20 again.
    const iterWrite = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "swift-vine"
        && (c[2] as { trellis?: { iteration?: number } }).trellis?.iteration !== undefined,
    );
    expect(iterWrite).toBeUndefined();
    // And the cap was not tripped by a phantom increment.
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "swift-vine",
      expect.objectContaining({ failingReason: "iteration-budget" }),
    );
  });

  it("a fresh (non-retry) trellis launch DOES increment the iteration counter", () => {
    // Positive control for the guard above: without retry state, launchReview
    // advances the counter exactly as before (20 -> 21). This proves the
    // !isRetryRelaunch guard doesn't disable the normal per-iteration increment.
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "swift-vine",
        prState: "working",
        agentStatus: "idle",
        workflow: "trellis",
        pendingReviewAt: Date.now(),
        trellis: { name: "auth", path: "/tmp/auth.md", iteration: 20, maxIterations: 30 },
      }),
    ]);

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "swift-vine",
      expect.objectContaining({ trellis: { iteration: 21 } }),
    );
  });

  it("a quota-retry relaunch does NOT re-increment the grow iteration counter (but still launches)", () => {
    // Same guard for grow: an inflated grow.iteration would make maybeAutoContinue
    // see the budget as spent and end the hardening loop several passes early once
    // the window resets and the review merges. The relaunch must still fire.
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "tall-fern",
        prState: "working",
        agentStatus: "idle",
        workflow: "grow",
        pendingReviewAt: Date.now(),
        quotaRetryCount: 2,
        reviewRetryAt: Date.now() - 1000,
        grow: { seed: "harden auth", iteration: 4, maxIterations: 5 },
      }),
    ]);

    poll("myproject");

    const iterWrite = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "tall-fern"
        && (c[2] as { grow?: { iteration?: number } }).grow?.iteration !== undefined,
    );
    expect(iterWrite).toBeUndefined();
    // The review still launches (grow uses the default prompt builder).
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "tall-fern",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });

  it("retries with backoff for a Codex reviewer whose transient error lands only in the stderr sidecar", () => {
    // Codex splits its streams: verdict -> stdout (result file), errors +
    // progress -> a stderr sidecar. On a transient backend error Codex
    // typically writes NOTHING to stdout, so rawOutput is null and the error is
    // ONLY in the sidecar. The transient-retry safety net must still engage,
    // which requires (a) not gating the check on rawOutput !== null, and (b)
    // reading the sidecar BEFORE cleanReviewFiles deletes it. The deletion-
    // tracking fs mock below guards both: if the sidecar were read after clean,
    // existsSync would return false and the worker would wrongly park in failing.
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      roles: { reviewer: { harness: "codex" } },
    } as ReturnType<typeof tryGetProject>);
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
    const deleted = new Set<string>();
    vi.mocked(fs.unlinkSync).mockImplementation((p: unknown) => { deleted.add(String(p)); });
    // stdout result file is absent (rawOutput === null); only the sidecar exists.
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (deleted.has(s)) return false;
      return s.endsWith(".stderr");
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (deleted.has(s)) return "";
      if (s.endsWith(".stderr")) return "ERROR: 429 Too Many Requests - rate limit exceeded";
      return "{}";
    });
    // Head unchanged and remote unchanged, so neither the reviewer-committed-work
    // nor the worker-push recovery path fires — only the transient path can.
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");
    vi.mocked(getRemoteTrackingSha).mockReturnValue("abc123");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        reviewRetryCount: 1,
        reviewRetryAt: expect.any(Number),
      }),
    );
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 30_000);
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
  });

  it("falls back to the first-party Opus reviewer immediately when a Codex reviewer is quota-blocked", () => {
    // A foreign reviewer's quota is a multi-day subscription window; waiting it
    // out (the claude-code 15-min ladder) would wedge the whole merge pipeline
    // for days. Operator decision 2026-07-16: fall back to Opus at once. Driven
    // by the real captured Codex stderr — usage limit, "try again at <date>",
    // stdout empty (the quota line lands only in the sidecar).
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      roles: { reviewer: { harness: "codex" } },
    } as ReturnType<typeof tryGetProject>);
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
    const deleted = new Set<string>();
    vi.mocked(fs.unlinkSync).mockImplementation((p: unknown) => { deleted.add(String(p)); });
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (deleted.has(s)) return false;
      return s.endsWith(".stderr"); // only the sidecar exists; stdout is empty
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (deleted.has(s)) return "";
      if (s.endsWith(".stderr")) {
        return "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex "
          + "(https://chatgpt.com/explore/plus), or try again at Jul 31st, 2026 11:43 AM.";
      }
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");   // HEAD not advanced
    vi.mocked(getRemoteTrackingSha).mockReturnValue("abc123"); // remote not advanced

    poll("myproject");

    // Re-queued immediately on the fallback harness, NOT the 15-min quota ladder.
    expect(forcePushBranch).not.toHaveBeenCalled();
    const fallbackCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash"
        && (c[2] as Record<string, unknown>).reviewFallbackHarness === "claude-code",
    );
    expect(fallbackCall).toBeDefined();
    const fields = fallbackCall![2] as Record<string, unknown>;
    expect(fields.prState).toBe("working");
    expect(fields.pendingReviewAt).toEqual(expect.any(Number));
    expect(fields.quotaRetryCount).toBeUndefined(); // not the wait-it-out path
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 0);
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
    // Warn alert names the quota-blocked harness (Codex) + the reset, deduped,
    // and says it fell back to Opus.
    const alert = vi.mocked(addAlert).mock.calls.find(
      c => String((c[0] as { dedupKey?: string }).dedupKey).startsWith("quota-fallback:"),
    );
    expect(alert).toBeDefined();
    const spec = alert![0] as { level: string; message: string };
    expect(spec.level).toBe("warn");
    expect(spec.message).toContain("Codex");
    expect(spec.message).toContain("Jul 31st, 2026 11:43 AM");
    expect(spec.message).toContain("Opus");
  });

  it("waits out the 15-min ladder (naming Claude) when the Opus fallback ALSO hits quota", () => {
    // The configured reviewer is codex, but a prior quota fallback is active
    // (reviewFallbackHarness set), so THIS review already ran on claude-code/Opus.
    // If the operator's own Claude window is ALSO exhausted there is no stronger
    // fallback — wait it out on the flat 15-min ladder, and name Claude (the
    // harness that actually hit quota), not codex.
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      roles: { reviewer: { harness: "codex" } },
    } as ReturnType<typeof tryGetProject>);
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
        reviewFallbackHarness: "claude-code",
      }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
    // claude-code merges stderr into the result file (2>&1) — quota line on stdout.
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).includes("review-result"));
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result")
        ? "Reviewing…\nYou've hit your session limit · resets 3:40pm (America/Denver)"
        : "{}");
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");
    vi.mocked(getRemoteTrackingSha).mockReturnValue("abc123");

    poll("myproject");

    // The 15-min quota ladder, NOT another fallback (already fell back once).
    const quotaCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).quotaRetryCount === 1,
    );
    expect(quotaCall).toBeDefined();
    expect((quotaCall![2] as Record<string, unknown>).prState).toBe("working");
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 900_000);
    // The working-retry transition does NOT clear the fallback flag: it persists
    // on the entry so each quota retry re-uses the Opus fallback.
    expect((quotaCall![2] as Record<string, unknown>).reviewFallbackHarness).toBeUndefined();
    // No second fallback alert — this is the wait, not another downgrade.
    expect(vi.mocked(addAlert).mock.calls.some(
      c => String((c[0] as { dedupKey?: string }).dedupKey).startsWith("quota-fallback:"),
    )).toBe(false);
    // Alert names Claude (the fallback that hit quota), not codex.
    const alert = vi.mocked(addAlert).mock.calls.find(
      c => String((c[0] as { dedupKey?: string }).dedupKey).startsWith("quota-review:"),
    );
    expect(alert).toBeDefined();
    const msg = String((alert![0] as { message: string }).message);
    expect(msg).toContain("Claude");
    expect(msg).not.toContain("Codex");
    expect(msg).toContain("3:40pm (America/Denver)");
  });

  it("launchReview pins the fallback review to claude-code/Opus, ignoring the quota-blocked Codex reviewer", () => {
    // The load-bearing half of the fallback: once handleQuotaFallbackReview has
    // stamped reviewFallbackHarness, the NEXT launchReview must pin this cycle
    // to the first-party Opus safety net (claude-code + opus), regardless of the
    // configured foreign reviewer (codex) that is still quota-blocked. Without
    // the override, resolveReviewRole would relaunch on codex and re-hit quota.
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      roles: { reviewer: { harness: "codex" } },
    } as ReturnType<typeof tryGetProject>);
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working",
        agentStatus: "idle",
        pendingReviewAt: Date.now(),
        reviewFallbackHarness: "claude-code",
      }),
    ]);

    poll("myproject");

    const reviewLaunch = vi.mocked(newDashboardWindow).mock.calls.find(
      c => String(c[0]).includes("review"),
    );
    expect(reviewLaunch).toBeDefined();
    // claude-code/Opus, NOT a `codex exec` launch for the configured reviewer.
    const cmd = String(reviewLaunch![5]);
    expect(cmd).toContain("--model opus");
    expect(cmd).not.toContain("codex");
    // The relaunch re-reviews the same commits — the transition to reviewing
    // still fires (isRetryRelaunch keys off reviewFallbackHarness, so a
    // trellis/grow iteration counter would not advance here).
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });

  it("transitions to failing with reason transient-review after the budget is exhausted", () => {
    // Three prior attempts already burned; this is attempt #4 and it should
    // escalate to failing with failingReason="transient-review" instead of
    // continuing to retry forever.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
        reviewRetryCount: 3,
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
        return `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;
      }
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failingReason: "transient-review",
        failingSha: "pre456",
        reviewRetryCount: undefined,
        reviewRetryAt: undefined,
      }),
    );
  });

  it("routes non-transient unparseable output to the unparseable retry (not the transient path)", () => {
    // Garbled reviewer output that doesn't match a transient API-error pattern
    // must go through the unparseable-verdict path, NOT the transient one. With
    // head unchanged and retry budget remaining, that path now auto-retries on a
    // short backoff instead of failing immediately (a verdict-less reviewer that
    // committed nothing is a benign flake, so give it a fresh run first).
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
        return "reviewer wrote a long body but forgot the verdict line";
      }
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        unparseableRetryCount: 1,
        reviewRetryAt: expect.any(Number),
      }),
    );
    // Not misrouted to the transient path...
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ reviewRetryCount: 1 }),
    );
    // ...and not an immediate failing.
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
  });

  it("recovers an unparseable verdict via the Haiku fallback and dispatches instead of re-reviewing", () => {
    // The reviewer reached a conclusion but didn't format the token (the
    // operator's screenshot: a prose tail). parseLastLineVerdict returns null,
    // but before re-reviewing, the Haiku classifier reads the reviewer's output
    // and recovers CLEAN — so the worker dispatches to merge-pending (force-push
    // + merge), NOT the unparseable re-review/backoff.
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
        return "Reviewed the diff and reran the suite.\n"
          + "Final suite is green (2609 unit + 103 integration, lint clean).";
      }
      return "{}";
    });
    // CLEAN dispatch's stale-verdict guard compares remote vs lastSeenSha; keep
    // them equal so it doesn't reset to working on a phantom worker push.
    vi.mocked(getRemoteTrackingSha).mockReturnValue("abc123");
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456");
    vi.mocked(extractReviewVerdict).mockReturnValue("CLEAN");

    poll("myproject");

    expect(extractReviewVerdict).toHaveBeenCalledOnce();
    // Recovered verdict dispatched through the normal CLEAN path.
    expect(forcePushBranch).toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        lastReview: expect.objectContaining({ verdict: "clean" }),
      }),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
    // Not the unparseable re-review path.
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ unparseableRetryCount: expect.any(Number) }),
    );
  });

  it("auto-retries a no-commit unparseable verdict on a bounded backoff (the observed reviewer flake)", () => {
    // The concrete failure this path guards: a benign review where the reviewer
    // ended its turn with a filler sentence ("I'll wait for the workflow result
    // before rendering the verdict.") instead of a standalone CLEAN/FIXED/FAILED
    // token, having committed nothing. The reviewed diff is fine; the reviewer
    // just failed to verbalize. It must NOT drop straight to `failing` (which
    // needs a manual `garden kick`) — it should re-review on a short backoff.
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
        return "Kicked off 4 dimensions x independent skeptic verification.\nI'll wait for the workflow result before rendering the verdict.";
      }
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456"); // reviewer committed nothing

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        unparseableRetryCount: 1,
        reviewRetryAt: expect.any(Number),
        reviewWindowName: undefined,
      }),
    );
    // Backoff scheduled, not immediate; worker is not in failing.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 15_000);
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
  });

  it("auto-retries a SECOND no-commit unparseable verdict before failing (budget 2, not 1)", () => {
    // Boundary guard for MAX_UNPARSEABLE_REVIEW_RETRIES=2: a worker that already
    // spent one retry (unparseableRetryCount=1) must retry AGAIN (to 2), not park
    // in failing. This prior-count is the only value that distinguishes a budget
    // of 2 from a budget of 1 — without it, an off-by-one (`<=` -> `<`) that
    // silently halves the advertised budget would pass every other test.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
        unparseableRetryCount: 1, // one retry already spent; one remains
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
        return "Still deliberating.\nI'll fold in the sub-agent results next turn.";
      }
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre456"); // reviewer committed nothing

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        unparseableRetryCount: 2,
        reviewRetryAt: expect.any(Number),
      }),
    );
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 15_000);
    // Still under budget — must NOT escalate to failing yet.
    expect(updateWorkerFields).not.toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
  });

  it("a no-commit unparseable retry relaunch does NOT re-increment the trellis iteration counter", () => {
    // Same guard as the transient/quota retries: an unparseable retry re-reviews
    // the SAME commits (the reviewer emitted no verdict and did no work), so
    // launchReview must not treat it as a fresh iteration. unparseableRetryCount
    // marks the retry.
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "swift-vine",
        prState: "working",
        agentStatus: "idle",
        workflow: "trellis",
        pendingReviewAt: Date.now(),
        unparseableRetryCount: 1,
        reviewRetryAt: Date.now() - 1000, // backoff already elapsed
        trellis: { name: "auth", path: "/tmp/auth.md", iteration: 20, maxIterations: 30 },
      }),
    ]);

    poll("myproject");

    // No iteration write of any value: the relaunch reviews iteration 20 again.
    const iterWrite = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "swift-vine"
        && (c[2] as { trellis?: { iteration?: number } }).trellis?.iteration !== undefined,
    );
    expect(iterWrite).toBeUndefined();
    // The review still launches.
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "swift-vine",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });

  it("falls through to unparseable-verdict retry when reviewer committed work even if tail looks transient", () => {
    // Defensive: the unparseable-verdict retry path handles the case where
    // the reviewer rebased + committed fixes before crashing. Even if the
    // tail matches a transient pattern, we must not re-launch the same
    // review on top of unpushed reviewer work — handleUnparseableReview
    // force-pushes and re-queues exactly one review.
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
        return "API Error: 500 server-side issue";
      }
      return "{}";
    });
    // Head HAS advanced — reviewer committed fixes before the API blew up.
    vi.mocked(getBranchHeadSha).mockReturnValue("post789");

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        unparseableReviewAt: expect.any(Number),
      }),
    );
  });

  it("parks in failing/unparseable-verdict once the no-commit retry budget is exhausted (kick-recoverable)", () => {
    // The reviewer made no commits (HEAD unchanged) and the auto-retry budget is
    // already spent (unparseableRetryCount at MAX_UNPARSEABLE_REVIEW_RETRIES=2).
    // Now it must escalate to `failing` with failingReason="unparseable-verdict"
    // — the kick-recoverable reason (kick.ts REVIEW_SIDE_FAILING_REASONS) — and
    // clear the counter so a `garden kick` starts a clean cycle.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123",
        preReviewSha: "pre456",
        unparseableRetryCount: 2, // at budget
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
        failingReason: "unparseable-verdict",
        // Pin failingSha so handleFailing's debounce gate refuses to retry.
        failingSha: "pre456",
        // Counter cleared so a kick re-queue starts fresh.
        unparseableRetryCount: undefined,
      }),
    );
  });

  it("auto-retries (then fails) when the review result file is missing entirely", () => {
    // A missing result file means the reviewer process left no trace — it died
    // or was killed before writing any output. That is a reviewer flake, not a
    // code failure, so with retry budget remaining it re-queues on the backoff
    // (rather than dropping the worker straight into failing as it used to).
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
        prState: "working",
        unparseableRetryCount: 1,
        reviewRetryAt: expect.any(Number),
        reviewWindowName: undefined,
      }),
    );
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 15_000);
  });

  it("transitions to failing when the review result file is missing and the retry budget is spent", () => {
    // Budget-exhaustion companion to the missing-file retry above: once the
    // no-commit retries are used up, a persistently-absent result file escalates
    // to failing/unparseable-verdict (kick-recoverable).
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "abc123", unparseableRetryCount: 2 }),
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
        failingReason: "unparseable-verdict",
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
    // Reviewer window has exited; SHA change with NO result file is therefore
    // a genuine worker push (the reviewer left no trace of completion).
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockReturnValue(false); // no review-result file
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
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 0);
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

  it("dispatches FIXED verdict when reviewer pushed its fix and exited (no false worker-pushed reset)", () => {
    // Regression for the stuck-loop seen on west-old-reef (2026-05-20):
    // reviewer pushed a FIXED commit, exited; handleReviewing saw window-gone
    // + remoteSha != lastSeenSha and reset to "working", silently dropping the
    // FIXED verdict and looping the review until the reviewer happened to
    // converge on no-op. The verdict file must be consulted FIRST so the
    // reviewer's own push is dispatched, not misattributed.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "pre-fix-sha",
      }),
    ]);
    vi.mocked(getRemoteTrackingSha).mockReturnValue("reviewer-fix-sha"); // reviewer's own push
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Fixed SSR hydration.\nFIXED";
      return "{}";
    });

    poll("myproject");

    // FIXED → force-push + merge-pending. NOT the worker-pushed reset path.
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
    const resetCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "working",
    );
    expect(resetCall).toBeUndefined();
  });

  it("resets to working when a worker pushed new commits during a CLEAN review (stale verdict)", () => {
    // The reviewer found nothing to change (CLEAN) so it pushed nothing — yet
    // origin advanced past the reviewed SHA. That advance is the worker's own
    // mid-review push; force-pushing a CLEAN stamp onto it would merge
    // never-reviewed code. The verdict must be discarded and the new commits
    // re-reviewed. (Contrast west-old-reef above: a FIXED reviewer-push is
    // SHA-indistinguishable and must still dispatch, so the guard is CLEAN-only.)
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "reviewed-sha",
      }),
    ]);
    vi.mocked(getRemoteTrackingSha).mockReturnValue("worker-pushed-sha");
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result") ? "Looks good.\nCLEAN" : "{}",
    );
    vi.mocked(getCommitSummary).mockReturnValue("worker-pushed-sha new work");

    poll("myproject");

    expect(forcePushBranch).not.toHaveBeenCalled();
    const mergePendingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "merge-pending",
    );
    expect(mergePendingCall).toBeUndefined();
    const resetCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "working",
    );
    expect(resetCall).toBeDefined();
    expect((resetCall![2] as Record<string, unknown>).pendingReviewAt).toEqual(expect.any(Number));
  });

  it("dispatches CLEAN when the remote SHA is unreadable (fail-open, no false reset)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        lastSeenSha: "reviewed-sha",
      }),
    ]);
    vi.mocked(getRemoteTrackingSha).mockReturnValue(null);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result") ? "Looks good.\nCLEAN" : "{}",
    );

    poll("myproject");

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
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

describe("poll — holistic final review (interposed whole-task review)", () => {
  // The interposed final review (poller-holistic-review.ts) reuses the
  // `reviewing` state with holisticFinalActive set. handleReviewing branches to
  // handleHolisticFinalReview, whose disposition differs from a per-phase verdict:
  // shadow surfaces findings and finalizes done, a fix rides the merge gate,
  // FAILED parks in failing, and any no-commit outcome finalizes done.
  function setHolistic(over: Partial<WorkerEntry>): void {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        reviewWindowName: "_myproject-review-bold-ash",
        holisticFinalActive: true,
        reviewStartedAt: Date.now(),
        mergeCount: 3,
        lastSeenSha: "abc123",
        ...over,
      }),
    ]);
    // Review window gone (reviewer finished its turn); everything else exists.
    vi.mocked(windowExists).mockImplementation((name: string) => !name.includes("-review-"));
  }
  function reviewResult(body: string): void {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).includes("review-result"));
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result") ? body : "{}");
  }

  it("stays in reviewing while the reviewer window is still alive", () => {
    setHolistic({ holisticReviewMode: "fix" });
    vi.mocked(windowExists).mockReturnValue(true); // review window still exists
    poll("myproject");
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(registryMock.findWorkerByName("myproject", "bold-ash")!.prState).toBe("reviewing");
  });

  it("shadow mode: surfaces findings as an alert and finalizes done (never merges)", () => {
    setHolistic({ holisticReviewMode: "shadow" });
    reviewResult("Phase 1 added X; phase 3 orphaned it.\nFAILED");
    poll("myproject");
    // Shadow is analysis-only: no push, no merge, and the FAILED verdict does
    // not fail the worker — it just reports.
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergeToBase).not.toHaveBeenCalled();
    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Holistic review FINDINGS"),
    }));
    const after = registryMock.findWorkerByName("myproject", "bold-ash")!;
    expect(after.prState).toBe("done");
    expect(after.holisticFinalActive).toBeUndefined();
    expect(after.holisticReviewedThroughMergeCount).toBe(3);
  });

  it("fix mode CLEAN (no commit): finalizes done without merging", () => {
    // preReviewSha == the mocked head SHA ("abc123") → the reviewer committed
    // nothing, so a CLEAN verdict just finalizes the worker.
    setHolistic({ holisticReviewMode: "fix", preReviewSha: "abc123" });
    reviewResult("No cross-phase defects.\nCLEAN");
    poll("myproject");
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergeToBase).not.toHaveBeenCalled();
    const after = registryMock.findWorkerByName("myproject", "bold-ash")!;
    expect(after.prState).toBe("done");
    expect(after.holisticFinalActive).toBeUndefined();
    expect(after.holisticReviewedThroughMergeCount).toBe(3);
  });

  it("fix mode FIXED with a commit: force-pushes, rides the merge gate, marker persists", () => {
    // preReviewSha differs from the mocked head SHA ("abc123") → a fix landed.
    setHolistic({ holisticReviewMode: "fix", preReviewSha: "pre0000" });
    reviewResult("Removed dead code a later phase orphaned.\nFIXED");
    poll("myproject");
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    const call = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "merge-pending",
    );
    expect(call).toBeDefined();
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 0);
    // holisticFinalActive rides merge-pending so transitionToTerminal finalizes
    // the fix merge straight to done (guard bumped, no auto-continue).
    expect(registryMock.findWorkerByName("myproject", "bold-ash")!.holisticFinalActive).toBe(true);
  });

  it("FAILED verdict (fix mode): parks in failing on an unfixable cross-phase defect", () => {
    setHolistic({ holisticReviewMode: "fix", preReviewSha: "abc123" });
    reviewResult("Phase 2 broke a contract phase 4 relies on.\nFAILED");
    poll("myproject");
    expect(mergeToBase).not.toHaveBeenCalled();
    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      message: expect.stringContaining("could not fix a cross-phase defect"),
    }));
    const after = registryMock.findWorkerByName("myproject", "bold-ash")!;
    expect(after.prState).toBe("failing");
    expect(after.failingReason).toBe("code");
    expect(after.holisticFinalActive).toBeUndefined();
    expect(after.holisticReviewedThroughMergeCount).toBe(3);
  });

  it("timeout: parks in failing and clears the holistic markers (no misroute on re-open)", () => {
    // Reviewer window still alive past the 60-min cap → handleReviewTimeout.
    // The shared timeout path must clear holisticFinalActive/holisticReviewMode
    // so a later failing → working → reviewing re-open is routed to the
    // per-phase reviewer, not misrouted back to handleHolisticFinalReview.
    setHolistic({
      holisticReviewMode: "fix",
      reviewStartedAt: Date.now() - 60 * 60 * 1000 - 60_000,
    });
    vi.mocked(windowExists).mockReturnValue(true); // window alive = timeout, not completion
    poll("myproject");
    expect(killWindowSafe).toHaveBeenCalledWith("_myproject-review-bold-ash");
    const after = registryMock.findWorkerByName("myproject", "bold-ash")!;
    expect(after.prState).toBe("failing");
    expect(after.holisticFinalActive).toBeUndefined();
    expect(after.holisticReviewMode).toBeUndefined();
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
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });

    poll("myproject");

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "main");
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(mergeToBase).toHaveBeenCalledWith("/repo/myproject", "bold-ash", "main", { project: "myproject", worker: "bold-ash" });
    expect(deleteRemoteBranch).toHaveBeenCalledWith("/repo/myproject", "bold-ash", { project: "myproject", worker: "bold-ash" });
    expect(fastForwardBase).toHaveBeenCalledWith("/repo/myproject", "main", { project: "myproject", worker: "bold-ash" });
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "merged",
        mergedAt: expect.any(String),
        failCount: 0,
        mergePendingAt: undefined,
        // Both per-merge-cycle budgets reset on a successful merge so a
        // multi-phase worker's next cycle starts fresh (the ci-fix half was
        // previously leaking across the worker's lifetime).
        resolveAttempts: 0,
        ciFixAttempts: 0,
      }),
    );
  });

  it("clears merged to working when the worker becomes active during finalization (race)", () => {
    // The worker is idle when the merge guard runs (so finalization proceeds),
    // but the operator prompts it mid-finalize. Simulate the hook flipping
    // agentStatus to working while mergeToBase is in flight, so the guard passes
    // yet the post-merge race-clear still fires. (A statically-working worker now
    // hits the pre-merge guard and never reaches finalization.)
    const w = makeWorker({
      prState: "merge-pending",
      mergePendingAt: new Date(Date.now() - 1000).toISOString(),
    });
    registryMock._setEntries("myproject", [w]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
    vi.mocked(mergeToBase).mockImplementation(() => { w.agentStatus = "working"; });

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
      "poller", "worker active again, clearing merge state",
      expect.objectContaining({ worker: "bold-ash" }),
    );
  });

  it("dispatches auto-continue when worker is idle and no .garden-done sentinel", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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

  it("holistic fix merge: finalizes straight to done, skips auto-continue, bumps the guard", () => {
    // The interposed whole-task review pushed a cross-phase fix (holisticFinalActive
    // rode merge-pending). transitionToTerminal must finalize it to `done` (not the
    // transient `merged` beat), clear the markers, advance the high-water guard past
    // this mergeCount so it never re-fires, and NOT auto-continue (the worker is done).
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        holisticFinalActive: true,
        holisticReviewMode: "fix",
        mergeCount: 3,
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
    vi.mocked(isDoneSet).mockReturnValue(false); // no sentinel; the marker drives `done`

    poll("myproject");

    const doneCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "done",
    );
    expect(doneCall).toBeDefined();
    const fields = doneCall![2] as Record<string, unknown>;
    expect(fields.holisticFinalActive).toBeUndefined();
    expect(fields.holisticReviewMode).toBeUndefined();
    // mergeCount incremented 3 -> 4; the guard advances past it so it never re-fires.
    expect(fields.holisticReviewedThroughMergeCount).toBe(4);
    // A done holistic pass never continues and never re-dispatches.
    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "poller", "holistic review fix merged; worker done",
      expect.objectContaining({ worker: "bold-ash" }),
    );
  });

  it("skips auto-continue when the worker becomes active during finalization (race)", () => {
    // Idle at the pre-merge guard (so finalization proceeds), then the operator
    // prompts it mid-finalize. The finalize-time skip (agentStatus flips to
    // working before maybeAutoContinue) must suppress the post-merge prompt. A
    // statically-working worker now defers at the pre-merge guard and never
    // reaches this path, so flip the status mid-merge to exercise the skip.
    const w = makeWorker({
      prState: "merge-pending",
      mergePendingAt: new Date(Date.now() - 1000).toISOString(),
    });
    registryMock._setEntries("myproject", [w]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
    vi.mocked(mergeToBase).mockImplementation(() => { w.agentStatus = "working"; });

    poll("myproject");

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("skips auto-continue inside the idempotency window", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastAutoContinueAt: Date.now() - 1000, // 1s ago, well inside the 10s window
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });

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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "same-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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

  it("alerts at error level when sync fails with a non-dirty git error", () => {
    // The dirty path renders as a recoverable warn — operator can stash/commit.
    // A fetch-failed or reset-failed sync is a real git problem (network,
    // disk, ref state) and warrants the higher-severity error alert.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
    vi.mocked(syncWorktreeToRemote).mockReturnValue({
      ok: false, reason: "fetch-failed", error: "fatal: unable to reach origin",
    });

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        worker: "bold-ash",
        message: expect.stringMatching(/fetch-failed/),
      }),
    );
    const mergedCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "merged",
    );
    expect(mergedCall![2]).toMatchObject({
      pendingContinueSyncFailed: true,
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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        preReviewSha: "pre-review-sha",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
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

  it("skips postMerge and warns (not errors) when the local checkout is dirty", () => {
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
    vi.mocked(fastForwardBase).mockReturnValue({ ok: false, reason: "dirty", currentBranch: "main", error: "dirty" });

    poll("myproject");

    // postMerge command must not execute against a stale checkout.
    expect(execSync).not.toHaveBeenCalledWith(
      "npm run build",
      expect.anything(),
    );
    // A dirty checkout is the operator's own working state, not a merge failure
    // — warn, and lead with the fact that the merge already landed on origin.
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringMatching(/merged to origin\/main.*uncommitted changes.*postMerge was skipped/),
      }),
    );
    // Worker still reaches merged — the remote merge succeeded, only the
    // local rebuild was deferred.
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged" }),
    );
  });

  it("errors when the local checkout is wedged (stuck: fetch failed) even without postMerge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    // A wedged/unfetchable checkout is infra trouble, not the operator's normal
    // working state — that one stays error-level regardless of postMerge.
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined,
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: false, reason: "stuck", error: "fatal: unable to access origin" });

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringContaining("could not be advanced"),
      }),
    );
  });

  it("alerts only on entry into the un-advanceable state, not every merge cycle", () => {
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined, postMerge: "npm run build",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: false, reason: "dirty", currentBranch: "main", error: "dirty" });

    // Each merge re-seeds a fresh merge-pending worker (updateWorkerFields
    // mutates the prior one to `merged` in place), so both polls genuinely run
    // the post-merge path with the same dirty checkout — only the first alerts.
    const seedMergePending = () => registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);

    seedMergePending();
    poll("myproject"); // entry into dirty -> alert
    seedMergePending();
    poll("myproject"); // still dirty -> suppressed

    expect(vi.mocked(addAlert).mock.calls.filter(
      c => /uncommitted changes/.test(String((c[0] as { message?: string }).message ?? "")),
    )).toHaveLength(1);
  });

  it("advances the off-base ref silently — no alert, no postMerge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        baseBranch: "develop",
      }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined, postMerge: "npm run build",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    // Checkout parked on another branch; the ref simply trailed origin and was
    // advanced without touching the working tree — the deliberate many-base
    // workflow, not drift.
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "ref" });

    poll("myproject");

    // postMerge must not run — the working tree is on a different branch.
    expect(execSync).not.toHaveBeenCalledWith("npm run build", expect.anything());
    expect(addAlert).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged" }),
    );
  });

  it("warns (not errors) when the local base ref has diverged from origin", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        baseBranch: "develop",
      }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined,
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({
      ok: false, reason: "diverged", currentBranch: "operator-manual", ahead: 3, behind: 2,
    });

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringMatching(/merged to origin\/develop.*diverged from origin \(3 ahead, 2 behind\)/),
      }),
    );
  });

  it("warns (not errors) and names the worktree when the base is checked out elsewhere", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        baseBranch: "develop",
      }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", checks: undefined,
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({
      ok: false, reason: "checked-out-elsewhere", currentBranch: "operator-manual", checkedOutAt: "/some/wt",
    });

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "poller",
        project: "myproject",
        worker: "bold-ash",
        message: expect.stringMatching(/merged to origin\/develop.*checked out in another worktree \(\/some\/wt\)/),
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
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });

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
        agentStatus: "idle",
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
    expect(newDashboardWindow).toHaveBeenCalledWith(
      "_myproject-review-bold-ash",
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
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        resolveAttempts: 2, // budget already consumed
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "conflict" });
    vi.mocked(getUnmergedFiles).mockReturnValue(["src/foo.ts", "src/bar.ts"]);

    poll("myproject");

    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    // No new resolver window launched
    expect(newDashboardWindow).not.toHaveBeenCalledWith(
      "_myproject-review-bold-ash",
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

  it("defers the whole merge (no worktree mutation) when the worker's Claude is active", () => {
    // The operator prompted this merge-pending worker; it may be editing tracked
    // files that are not yet committed. handleMergePending must defer BEFORE
    // cleanWorktree/rebase so those edits are never wiped.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "working",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "conflict" });

    poll("myproject");

    expect(cleanWorktree).not.toHaveBeenCalled();
    expect(rebaseBranch).not.toHaveBeenCalled();
    expect(mergeToBase).not.toHaveBeenCalled();
  });

  it("resumes an already-pushed merge even while the worker's Claude is active", () => {
    // The mid-turn guard sits deliberately AFTER the resume check: a prior
    // finalization already fast-forward-pushed HEAD onto origin/<base> (poller
    // torn down mid-finalize by a rebuild), so finishing the idempotent tail is
    // safe and must not be blocked just because the worker resumed working. If
    // the guard were moved above the resume check this would defer indefinitely.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "working",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(isAncestor).mockReturnValue(true); // HEAD already contained in origin/<base>
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });

    poll("myproject");

    expect(log.info).toHaveBeenCalledWith(
      "poller", "merge already on base, resuming interrupted finalization",
      expect.objectContaining({ worker: "bold-ash" }),
    );
    // Resumed the idempotent tail, did not re-merge or touch the worktree.
    expect(cleanWorktree).not.toHaveBeenCalled();
    expect(rebaseBranch).not.toHaveBeenCalled();
    expect(mergeToBase).not.toHaveBeenCalled();
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
        agentStatus: "idle",
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
    expect(mergeCalls[0]).toEqual(["/repo/myproject", "calm-bay", "main", { project: "myproject", worker: "calm-bay" }]);
  });

  it("re-arms and alerts (does not silently strand) when force-push fails in merge queue", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        // A resolver-verified branch reaches this force-push with the budget
        // spent; the re-arm must reset it so the re-reviewed cycle is fresh.
        resolveAttempts: 2,
      }),
    ]);
    vi.mocked(forcePushBranch).mockImplementation(() => { throw new Error("push failed"); });

    poll("myproject");

    expect(mergeToBase).not.toHaveBeenCalled();
    // Re-arm rather than strand: pendingReviewAt set so handleWorking re-reviews
    // (retrying the push), merge-queue timestamp cleared, and the resolver budget
    // reset so the fresh cycle does not inherit an exhausted count.
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        mergePendingAt: undefined,
        resolveAttempts: 0,
      }),
    );
    // A delayed poke guarantees the retry even with no other event, and the
    // operator is alerted (deduped) so a persistent failure is visible.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 30_000);
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: "push-failed:myproject:bold-ash" }),
    );
  });

  it("re-arms for re-review on the first merge failure (bounded retry)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        resolveAttempts: 2, // budget-exhausted from a prior resolved conflict
      }),
    ]);
    vi.mocked(mergeToBase).mockImplementation(() => { throw new Error("merge conflict"); });

    poll("myproject");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "poller",
        project: "myproject",
        message: expect.stringContaining("Merge failed"),
        dedupKey: "merge-retry:myproject:bold-ash",
      }),
    );
    // Re-arms a fresh review cycle and resets the resolver budget so the next
    // genuine conflict isn't spuriously escalated by a carried-over count.
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        failCount: 1,
        mergePendingAt: undefined,
        resolveAttempts: 0,
      }),
    );
    // Must schedule a delayed poke so the poller picks up the re-review
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", expect.any(Number));
  });

  it("parks in failing after MAX_MERGE_RETRIES consecutive merge failures", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        failCount: 2, // one more failure reaches the budget of 3
      }),
    ]);
    vi.mocked(mergeToBase).mockImplementation(() => { throw new Error("branch protection"); });

    poll("myproject");

    // Escalates instead of re-reviewing again — visible, kick-recoverable.
    // failingSha is pinned so handleFailing keeps it parked rather than
    // debouncing back to `working` on its 30s timer.
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failingReason: "transient-review",
        failCount: 3,
        failingSha: "abc123",
      }),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        dedupKey: "merge-failed:myproject:bold-ash",
      }),
    );
  });

  // ─── grow workflow: budget exhaustion → done at the auto-continue site ──
  // Locked decision 2 in declarative-singing-graham.md: grow's
  // terminal-on-budget is `done` (not `failing` like trellis), and the
  // check fires post-merge in maybeAutoContinue (not at preflight). Reaching
  // the cap means "we did the work we said we'd do."

  it("grow: writes .garden-done and transitions merged → done when iter == max", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        workflow: "grow",
        grow: { seed: "harden auth", iteration: 5, maxIterations: 5 },
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });

    poll("myproject");

    expect(setDoneSentinel).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    const doneCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "done",
    );
    expect(doneCall).toBeDefined();
    // The auto-continue dispatch must NOT fire — the loop is over.
    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
    const lastAcCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).lastAutoContinueAt !== undefined,
    );
    expect(lastAcCall).toBeUndefined();
  });

  it("grow: dispatches the cold respawn when iter < max (budget not yet hit)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        agentStatus: "idle",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        workflow: "grow",
        grow: { seed: "harden auth", iteration: 2, maxIterations: 5 },
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });

    poll("myproject");

    // Sentinel must NOT be written for a mid-loop merge.
    expect(setDoneSentinel).not.toHaveBeenCalled();
    // The cold-respawn dispatch fires via spawn (the sleep-then-call helper).
    expect(spawn).toHaveBeenCalledWith(
      "sh",
      ["-c", expect.stringContaining("_grow-continue-after-merge")],
      expect.objectContaining({ detached: true }),
    );
    // The default-workflow auto-continue must NOT fire.
    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });
});

describe("poll — merge-pending CI gate", () => {
  beforeEach(() => {
    // Default project config has requireCiSuccess unset → gate runs.
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject" } as ReturnType<typeof tryGetProject>);
    vi.mocked(getGitHubRepoSlug).mockReturnValue("owner/repo");
    vi.mocked(checkCiStatus).mockReturnValue({ kind: "success" });
    vi.mocked(rebaseBranch).mockReturnValue({ kind: "ok" });
    vi.mocked(fastForwardBase).mockReturnValue({ ok: true, advanced: "worktree" });
    vi.mocked(getBranchHeadSha).mockReturnValue("deadbeefcafe");
  });

  function pending(): WorkerEntry {
    return makeWorker({
      prState: "merge-pending",
      mergePendingAt: new Date(Date.now() - 1000).toISOString(),
    });
  }

  it("passes through when ci status is success — merges as normal", () => {
    registryMock._setEntries("myproject", [pending()]);

    poll("myproject");

    expect(checkCiStatus).toHaveBeenCalledWith("owner/repo", "deadbeefcafe");
    expect(mergeToBase).toHaveBeenCalled();
  });

  it("defers the merge when ci is pending — schedules a recheck and does NOT merge", () => {
    vi.mocked(checkCiStatus).mockReturnValue({
      kind: "pending",
      pending: ["test"],
    });
    registryMock._setEntries("myproject", [pending()]);

    poll("myproject");

    expect(mergeToBase).not.toHaveBeenCalled();
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 60_000);
    // Worker stays in merge-pending — no state mutation other than (possibly)
    // the unchanged update from upstream handlers.
    const fields = vi.mocked(updateWorkerFields).mock.calls.filter(c => c[1] === "bold-ash");
    expect(fields.find(c => (c[2] as Record<string, unknown>).prState !== undefined)).toBeUndefined();
  });

  it("dispatches the ci-fix agent when ci is red — does NOT park in failing on first attempt", () => {
    vi.mocked(checkCiStatus).mockReturnValue({
      kind: "failed",
      failed: [
        { name: "lint-and-test", conclusion: "failure", htmlUrl: "https://gh/runs/1" },
        { name: "schema-compat", conclusion: "failure" },
      ],
    });
    registryMock._setEntries("myproject", [pending()]);

    poll("myproject");

    expect(mergeToBase).not.toHaveBeenCalled();
    // Worker transitions to ci-fixing, not failing.
    const ciFixingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "ci-fixing",
    );
    expect(ciFixingCall).toBeDefined();
    const fields = ciFixingCall![2] as Record<string, unknown>;
    expect(fields.ciFixAttempts).toBe(1);
    expect(fields.reviewWindowName).toBe("_myproject-ci-fix-bold-ash");
    expect(fields.mergePendingAt).toBeUndefined();

    // Launch is a routine lifecycle beat — logged, but NOT raised as an
    // operator alert (the badge is reserved for ci-fix budget exhaustion).
    const launchAlert = vi.mocked(addAlert).mock.calls.find(
      c => String((c[0] as { message?: string }).message ?? "").includes("CI fix-agent launched"),
    );
    expect(launchAlert).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("poller", "launched ci-fix", expect.anything());

    // No worker should be parked in failing on this first attempt.
    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeUndefined();

    // The ci-fix prompt file was written, and a hidden ci-fix window
    // was launched.
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("myproject-bold-ash-ci-fix-prompt.txt"),
      expect.any(String),
    );
    expect(newDashboardWindow).toHaveBeenCalledWith(
      "_myproject-ci-fix-bold-ash",
      "-c", "/tmp/wt/myproject/bold-ash", "bash", "-c", expect.any(String),
    );
  });

  it("escalates to failing with reason 'ci' once the ci-fix budget is exhausted", () => {
    vi.mocked(checkCiStatus).mockReturnValue({
      kind: "failed",
      failed: [
        { name: "lint-and-test", conclusion: "failure", htmlUrl: "https://gh/runs/1" },
      ],
    });
    // Worker arrives in merge-pending with budget already exhausted (3/3
    // prior attempts on this merge cycle). The next launchCiFix call
    // short-circuits into escalateCiFixBudget.
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        ciFixAttempts: 3,
      }),
    ]);

    poll("myproject");

    expect(mergeToBase).not.toHaveBeenCalled();
    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    const fields = failingCall![2] as Record<string, unknown>;
    expect(fields.failingReason).toBe("ci");
    expect(fields.mergePendingAt).toBeUndefined();
    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      message: expect.stringContaining("exhausted"),
    }));
  });

  it("passes through when origin is not a github remote", () => {
    vi.mocked(getGitHubRepoSlug).mockReturnValue(null);
    registryMock._setEntries("myproject", [pending()]);

    poll("myproject");

    expect(checkCiStatus).not.toHaveBeenCalled();
    expect(mergeToBase).toHaveBeenCalled();
  });

  it("passes through (with an alert) when gh is unavailable", () => {
    vi.mocked(checkCiStatus).mockReturnValue({
      kind: "unavailable",
      reason: "gh-not-installed",
    });
    registryMock._setEntries("myproject", [pending()]);

    poll("myproject");

    expect(mergeToBase).toHaveBeenCalled();
    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("gh-not-installed"),
    }));
  });

  it("passes through when the commit has no check-runs (no CI configured)", () => {
    vi.mocked(checkCiStatus).mockReturnValue({ kind: "no-ci" });
    registryMock._setEntries("myproject", [pending()]);

    poll("myproject");

    expect(mergeToBase).toHaveBeenCalled();
  });

  it("defers a no-ci SHA on a project already known to have CI (fresh force-push grace)", () => {
    registryMock._setEntries("myproject", [pending()]);
    // A prior poll observes pending check-runs — the gate learns this project
    // has CI.
    vi.mocked(checkCiStatus).mockReturnValue({ kind: "pending", pending: ["build"] });
    poll("myproject");
    expect(mergeToBase).not.toHaveBeenCalled();

    // Now the SHA shows zero check-runs — a freshly force-pushed reviewer-fix /
    // ci-fix commit whose runs have not materialized yet. The gate must NOT read
    // this as "no CI" and merge un-gated; it defers within the grace window.
    vi.mocked(checkCiStatus).mockReturnValue({ kind: "no-ci" });
    poll("myproject");
    expect(mergeToBase).not.toHaveBeenCalled();
  });

  it("passes a persistently no-ci SHA through once the grace window elapses", () => {
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      registryMock._setEntries("myproject", [pending()]);
      // Learn the project has CI, then observe zero check-runs on the same SHA:
      // the first no-ci poll stamps the grace start and defers.
      vi.mocked(checkCiStatus).mockReturnValue({ kind: "pending", pending: ["build"] });
      poll("myproject");
      vi.mocked(checkCiStatus).mockReturnValue({ kind: "no-ci" });
      poll("myproject");
      expect(mergeToBase).not.toHaveBeenCalled();

      // Past the 3-minute grace ceiling the gate concludes the SHA genuinely
      // has no check-runs (path-filtered commit, deleted workflow) and lets the
      // merge proceed rather than deferring forever.
      nowSpy.mockReturnValue(t0 + 3 * 60_000 + 1);
      poll("myproject");
      expect(mergeToBase).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("arms only one CI recheck poke across repeated defers in the same window", () => {
    // Freeze the clock so the armed window (now + 60s) stays in the future for
    // all three polls, exercising armCiRecheck's dedup guard deterministically.
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      vi.mocked(checkCiStatus).mockReturnValue({ kind: "pending", pending: ["build"] });
      registryMock._setEntries("myproject", [pending()]);

      // Three defers inside one 60s window: the first arms a recheck poke, the
      // next two must find one already scheduled and NOT stack another sleeper.
      poll("myproject");
      poll("myproject");
      poll("myproject");

      const recheckPokes = vi.mocked(scheduleDelayedPoke).mock.calls.filter(c => c[1] === 60_000);
      expect(recheckPokes).toHaveLength(1);
      expect(mergeToBase).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("skips the gate entirely when requireCiSuccess is false", () => {
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      requireCiSuccess: false,
    } as ReturnType<typeof tryGetProject>);
    registryMock._setEntries("myproject", [pending()]);

    poll("myproject");

    expect(checkCiStatus).not.toHaveBeenCalled();
    expect(getGitHubRepoSlug).not.toHaveBeenCalled();
    expect(mergeToBase).toHaveBeenCalled();
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
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 0);
  });

  it("re-arms and alerts (does not silently strand) when force-push fails after resolve", () => {
    setupResolver();
    vi.mocked(getBranchHeadSha).mockReturnValue("post-rebase-sha"); // differs from preResolveSha
    vi.mocked(isAncestor).mockReturnValue(true);
    vi.mocked(hasRebaseInProgress).mockReturnValue(false);
    vi.mocked(forcePushBranch).mockImplementation(() => { throw new Error("push failed"); });

    poll("myproject");

    // Verification passed and the push was attempted, but it threw — re-arm for
    // a fresh review rather than stranding the worker in an unwatched `working`
    // state. pendingReviewAt set, review/merge-queue fields cleared, and the
    // resolver budget (seeded to 1 by setupResolver) reset so the fresh cycle
    // does not inherit an exhausted count.
    expect(forcePushBranch).toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "working",
        pendingReviewAt: expect.any(Number),
        reviewWindowName: undefined,
        mergePendingAt: undefined,
        resolveAttempts: 0,
      }),
    );
    // A delayed poke guarantees the retry even with no other event, and the
    // operator is alerted (deduped) so a persistent failure is visible.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 30_000);
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: "push-failed:myproject:bold-ash" }),
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

  it("escalates with the kick-recoverable transient-review reason when the resolver hit a transient API error", () => {
    setupResolver({ resolveAttempts: 2 }); // at budget
    vi.mocked(isAncestor).mockReturnValue(false); // verification fails
    vi.mocked(getBranchHeadSha).mockReturnValue("post-sha");
    // The resolver's Claude couldn't reach the API — an outage, not a failed
    // resolve. Must escalate recoverably (kick), not with the `code` reason.
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result") ? "API Error: 529 overloaded_error" : "{}",
    );

    poll("myproject");

    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    expect((failingCall![2] as Record<string, unknown>).failingReason).toBe("transient-review");
    // The exhausted resolve budget must clear on entry to `failing`: a
    // transient-review failure is kick-recoverable, and kick re-queues a review
    // without resetting resolveAttempts, so a stale budget at exhaustion would
    // make the next genuine conflict re-escalate without launching a resolver.
    expect((failingCall![2] as Record<string, unknown>).resolveAttempts).toBe(0);
  });

  it("escalates recoverably (transient-review) when a Codex resolver hits its usage/quota limit", () => {
    // Cross-phase guard: the crew phase made the resolver foreign-capable, but a
    // Codex subscription usage-limit line carries no 429/5xx — isTransientError
    // misses it; only quotaLimitResetHint catches it (the same split the
    // reviewer's quota fallback keys off). Without checking both, a foreign
    // resolver's quota block mis-escalates to the kick-refused `code` reason. It
    // must park in kick-recoverable transient-review, matching the reviewer.
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      roles: { resolver: { harness: "codex" } },
    } as ReturnType<typeof tryGetProject>);
    setupResolver({ resolveAttempts: 2 }); // at budget
    vi.mocked(isAncestor).mockReturnValue(false); // verification fails
    vi.mocked(getBranchHeadSha).mockReturnValue("post-sha");
    // Codex sends the verdict to stdout (empty — it errored out) and the
    // usage-limit to the stderr sidecar. Real captured Codex stderr.
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith(".stderr")) {
        return "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex "
          + "(https://chatgpt.com/explore/plus), or try again at Jul 31st, 2026 11:43 AM.";
      }
      if (s.includes("review-result")) return "";
      return "{}";
    });

    poll("myproject");

    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    expect((failingCall![2] as Record<string, unknown>).failingReason).toBe("transient-review");
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

describe("poll — ci-fixing state", () => {
  function setupCiFix(
    overrides: Partial<import("../src/dashboard/registry.js").WorkerEntry> = {},
  ): void {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "ci-fixing",
        reviewWindowName: "_myproject-ci-fix-bold-ash",
        preCiFixSha: "pre-fix-sha",
        ciFixAttempts: 1,
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastSeenSha: "origin-baseline",
        failingSha: "pre-fix-sha",
        ...overrides,
      }),
    ]);
    // Default: ci-fix agent has exited (window gone).
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-ci-fix-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("ci-fix-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("ci-fix-result")) return "Patched lint config.\nFIXED";
      return "{}";
    });
    vi.mocked(getRemoteTrackingSha).mockReturnValue("origin-baseline");
  }

  it("returns false while the ci-fix window is still alive", () => {
    setupCiFix();
    vi.mocked(windowExists).mockReturnValue(true);

    poll("myproject");

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("transitions to merge-pending when FIXED and the agent pushed a new SHA", () => {
    setupCiFix();
    // Agent committed locally and pushed; both local HEAD and remote
    // tracking ref advanced to the new SHA — a single ref read returns
    // the same value across the handler's reads, so we use a single
    // mockReturnValue rather than a per-call sequence.
    vi.mocked(getBranchHeadSha).mockReturnValue("post-fix-sha");
    vi.mocked(getRemoteTrackingSha).mockReturnValue("post-fix-sha");

    poll("myproject");

    const mpCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "merge-pending",
    );
    expect(mpCall).toBeDefined();
    // Success is log-only now — no operator alert for the routine push.
    const successAlert = vi.mocked(addAlert).mock.calls.find(
      c => String((c[0] as { message?: string }).message ?? "").includes("CI fix-agent pushed fix"),
    );
    expect(successAlert).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("poller", "ci-fix pushed", expect.anything());
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 0);
  });

  it("retries when FIXED but no push happened (HEAD did not advance)", () => {
    setupCiFix();
    // Verdict says FIXED but the agent didn't push — preCiFixSha unchanged.
    vi.mocked(getBranchHeadSha).mockReturnValue("pre-fix-sha");

    poll("myproject");

    // Budget has 2 attempts left, so we bounce back to merge-pending
    // (NOT to failing). The next merge-pending tick re-runs CI gate,
    // re-spawns the ci-fix agent, counting toward the budget.
    const mpCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "merge-pending",
    );
    expect(mpCall).toBeDefined();
    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeUndefined();
  });

  it("escalates to failing when verdict FAILED and budget is exhausted", () => {
    setupCiFix({ ciFixAttempts: 3 });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("ci-fix-result")) return "Logs unreadable.\nFAILED";
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre-fix-sha");

    poll("myproject");

    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    const fields = failingCall![2] as Record<string, unknown>;
    expect(fields.failingReason).toBe("ci");
    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      message: expect.stringContaining("exhausted"),
    }));
    // A genuine failure (remote ref did not advance) IS ledgered.
    expect(recordCiFixOutcome).toHaveBeenCalled();
  });

  it("escalates with the kick-recoverable transient-review reason when the ci-fix agent hit a transient API error", () => {
    setupCiFix({ ciFixAttempts: 3 });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) =>
      String(p).includes("ci-fix-result") ? "API Error: 503 Service Unavailable" : "{}",
    );
    vi.mocked(getBranchHeadSha).mockReturnValue("pre-fix-sha");

    poll("myproject");

    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    expect((failingCall![2] as Record<string, unknown>).failingReason).toBe("transient-review");
  });

  it("escalates recoverably (transient-review) when a Codex ci-fix agent hits its usage/quota limit", () => {
    // Same cross-phase guard as the resolver: a foreign ci-fix agent's Codex
    // usage-limit surfaces only through quotaLimitResetHint, not isTransientError,
    // so it must NOT mis-escalate to the kick-refused `ci` reason.
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      roles: { ciFix: { harness: "codex" } },
    } as ReturnType<typeof tryGetProject>);
    setupCiFix({ ciFixAttempts: 3 });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith(".stderr")) {
        return "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex "
          + "(https://chatgpt.com/explore/plus), or try again at Jul 31st, 2026 11:43 AM.";
      }
      if (s.includes("ci-fix-result")) return "";
      return "{}";
    });
    vi.mocked(getBranchHeadSha).mockReturnValue("pre-fix-sha");

    poll("myproject");

    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    expect((failingCall![2] as Record<string, unknown>).failingReason).toBe("transient-review");
  });

  it("times out to failing and resets the ci-fix budget", () => {
    const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
    setupCiFix({
      ciFixAttempts: 2,
      reviewStartedAt: Date.now() - REVIEW_TIMEOUT_MS - 60 * 1000,
    });
    // Agent window still alive past the cap — a hung ci-fix agent.
    vi.mocked(windowExists).mockReturnValue(true);
    vi.mocked(getBranchHeadSha).mockReturnValue("hung-head-sha");

    poll("myproject");

    expect(killWindowSafe).toHaveBeenCalledWith("_myproject-ci-fix-bold-ash");
    const failingCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "failing",
    );
    expect(failingCall).toBeDefined();
    const fields = failingCall![2] as Record<string, unknown>;
    expect(fields.failingReason).toBe("ci");
    // The timeout park resets the budget so a worker that recovers from one
    // timeout doesn't carry a reduced budget into later merge cycles.
    expect(fields.ciFixAttempts).toBe(0);
    expect(fields.preCiFixSha).toBeUndefined();
  });

  it("resets to working on a worker-authored push during ci-fix", () => {
    setupCiFix({ lastSeenSha: "origin-baseline" });
    vi.mocked(getRemoteTrackingSha).mockReturnValue("worker-pushed-sha");
    vi.mocked(getCommitSummary).mockReturnValue("abc123 worker pushed fix");

    poll("myproject");

    const resetCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "working",
    );
    expect(resetCall).toBeDefined();
    const fields = resetCall![2] as Record<string, unknown>;
    expect(fields.ciFixAttempts).toBe(0);
    expect(fields.preCiFixSha).toBeUndefined();
    expect(fields.pendingReviewAt).toEqual(expect.any(Number));
    // A worker-push interruption is NOT a ci-fix outcome — it must not be
    // ledgered as a failure (mirrors the resolver, which omits it too).
    expect(recordCiFixOutcome).not.toHaveBeenCalled();
  });
});

describe("poll — reviewer prompt", () => {
  function setupForReview() {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", agentStatus: "idle", pendingReviewAt: Date.now() }),
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
      makeWorker({ prState: "working", agentStatus: "idle",
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
    vi.mocked(getChangedFiles).mockReturnValue(["docs/STATUS.md"]);
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
    expect(content).toContain("docs/STATUS.md");
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

    expect(scheduleDelayedPoke).toHaveBeenCalledWith("myproject", 30000);
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
      lastStateChangeAt: expect.any(Number),
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
  // The merged handler is two-legged: resume-on-new-commits recovery, then
  // the gate-reopen sweep (replay of the post-merge auto-continue decision
  // for workers stranded in `merged`).
  beforeEach(() => {
    vi.mocked(getCommitSummary).mockReturnValue("");
    vi.mocked(getAutoContinueConfig).mockReturnValue({
      enabled: true, usageThreshold: 95, resumeAfterReset: false,
    });
    _resetGateBlockThrottleForTest();
  });

  function strandedWorker(overrides: Partial<WorkerEntry> = {}) {
    return makeWorker({
      prState: "merged",
      agentStatus: "idle",
      mergedAt: new Date().toISOString(),
      ...overrides,
    });
  }

  it("transitions to working when new commits appear after merge", () => {
    registryMock._setEntries("myproject", [strandedWorker()]);
    vi.mocked(getCommitSummary).mockReturnValue("def456 add new feature");

    poll("myproject");

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working" }),
    );
    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("sweep re-dispatches the continue prompt for a stranded worker when the gate is open", () => {
    registryMock._setEntries("myproject", [strandedWorker()]);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).toHaveBeenCalledWith(
      "node /usr/local/bin/garden", "myproject", "bold-ash",
    );
    const lastAcCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).lastAutoContinueAt !== undefined,
    );
    expect(lastAcCall).toBeDefined();
  });

  it("surfaces a gate-closed sweep at info, throttled to once per worker", () => {
    vi.mocked(getAutoContinueConfig).mockReturnValue({
      enabled: false, usageThreshold: 95, resumeAfterReset: false,
      pausedUntil: "2099-01-01T00:00:00Z", pausedReason: "5h at 100%",
    });
    registryMock._setEntries("myproject", [strandedWorker()]);

    poll("myproject");
    poll("myproject"); // immediate re-poke — should be throttled, not re-logged

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
    const infoBlocks = vi.mocked(log.info).mock.calls.filter(
      c => c[1] === "auto-continue blocked by global gate",
    );
    expect(infoBlocks).toHaveLength(1);
    expect(infoBlocks[0][2]).toMatchObject({ data: { reason: "usage-paused" } });
  });

  it("re-logs immediately when a worker re-strands after the gate reopens", () => {
    const gateClosed = {
      enabled: false, usageThreshold: 95, resumeAfterReset: false,
      pausedUntil: "2099-01-01T00:00:00Z", pausedReason: "5h at 100%",
    };
    const gateOpen = { enabled: true, usageThreshold: 95, resumeAfterReset: false };
    const countInfoBlocks = () =>
      vi.mocked(log.info).mock.calls.filter(
        c => c[1] === "auto-continue blocked by global gate",
      ).length;

    // First strand while the gate is closed: logs once, stamping the throttle.
    vi.mocked(getAutoContinueConfig).mockReturnValue(gateClosed);
    registryMock._setEntries("myproject", [strandedWorker()]);
    poll("myproject");
    expect(countInfoBlocks()).toBe(1);

    // Gate reopens: the sweep dispatches and drops the throttle record. A fresh
    // stranded entry (no lastAutoContinueAt) keeps the per-worker idempotency
    // skip from masking the gate-block log on the re-strand below.
    vi.mocked(getAutoContinueConfig).mockReturnValue(gateOpen);
    registryMock._setEntries("myproject", [strandedWorker()]);
    poll("myproject");

    // Gate closes again within the hour: because the record was cleared on
    // reopen, this re-strand logs immediately rather than being suppressed by
    // the stale timestamp from the first closure.
    vi.mocked(getAutoContinueConfig).mockReturnValue(gateClosed);
    registryMock._setEntries("myproject", [strandedWorker()]);
    poll("myproject");
    expect(countInfoBlocks()).toBe(2);
  });

  it("sweep does not double-dispatch inside the stranded window of a prior dispatch", () => {
    registryMock._setEntries("myproject", [
      strandedWorker({ lastAutoContinueAt: Date.now() - 30_000 }),
    ]);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("sweep re-dispatches once the stranded window has passed", () => {
    registryMock._setEntries("myproject", [
      strandedWorker({ lastAutoContinueAt: Date.now() - 61_000 }),
    ]);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).toHaveBeenCalled();
  });

  it("sweep skips done-sentinel workers", () => {
    vi.mocked(isDoneSet).mockReturnValue(true);
    registryMock._setEntries("myproject", [strandedWorker()]);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("sweep skips exited workers", () => {
    registryMock._setEntries("myproject", [
      strandedWorker({ agentStatus: "exited" }),
    ]);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("sweep skips mid-turn workers", () => {
    registryMock._setEntries("myproject", [
      strandedWorker({ agentStatus: "working" }),
    ]);

    poll("myproject");

    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("sweep routes a stranded trellis worker through the trellis dispatch", () => {
    registryMock._setEntries("myproject", [
      strandedWorker({ workflow: "trellis" }),
    ]);

    poll("myproject");

    expect(spawn).toHaveBeenCalledWith(
      "sh",
      ["-c", expect.stringContaining("_trellis-continue-after-merge")],
      expect.objectContaining({ detached: true }),
    );
    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });

  it("sweep finishes a stranded grow worker at budget instead of continuing", () => {
    registryMock._setEntries("myproject", [
      strandedWorker({
        workflow: "grow",
        grow: { seed: "harden auth", iteration: 5, maxIterations: 5 },
      }),
    ]);

    poll("myproject");

    expect(setDoneSentinel).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    const doneCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => c[1] === "bold-ash" && (c[2] as Record<string, unknown>).prState === "done",
    );
    expect(doneCall).toBeDefined();
    expect(dispatchDelayedAutoContinue).not.toHaveBeenCalled();
  });
});

describe("postPush", () => {
  it("is a simple trigger", () => {
    expect(() => postPush()).not.toThrow();
  });
});

describe("poll — ghost sweep wiring", () => {
  // poll() runs sweepGhostEntries on every cycle and refreshes the dashboard
  // when something was dropped — this is what keeps the plot strip's working
  // spinner from staying lit after a fan-out handoff with partial bootstrap
  // failures. Without these assertions a regression that no-ops the call
  // (or stops calling refreshDashboard) would pass silently.
  it("calls refreshDashboard when sweepGhostEntries returns true", () => {
    vi.mocked(sweepGhostEntries).mockReturnValue(true);
    poll("myproject");
    expect(refreshDashboard).toHaveBeenCalled();
  });

  it("does not call refreshDashboard when sweepGhostEntries returns false", () => {
    vi.mocked(sweepGhostEntries).mockReturnValue(false);
    poll("myproject");
    expect(refreshDashboard).not.toHaveBeenCalled();
  });

  it("logs and continues pollProject when sweepGhostEntries throws", () => {
    vi.mocked(sweepGhostEntries).mockImplementation(() => {
      throw new Error("registry read failed");
    });
    expect(() => poll("myproject")).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      "poller", "sweepGhostEntries failed",
      expect.objectContaining({
        data: expect.objectContaining({ error: expect.stringContaining("registry read failed") }),
      }),
    );
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
        agentStatus: "idle", // alive
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

    expect(pasteAndSubmit).toHaveBeenCalledWith(
      "%5",
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
        agentStatus: "idle",
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

  it("skips dead sibling (agentStatus=exited)", () => {
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
        agentStatus: "exited",
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

  it("skips sibling whose .garden-done sentinel is set", () => {
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
        agentStatus: "idle", // alive — only the sentinel should suppress
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce(["src/foo.ts"])
      .mockReturnValueOnce(["src/foo.ts"]);
    vi.mocked(isDoneSet).mockImplementation(
      (wt: string | undefined) => wt === "/tmp/wt/myproject/calm-bay",
    );

    poll("myproject");

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
      lastStateChangeAt: expect.any(Number),
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
        agentStatus: "idle",
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
    // side of restart runs. startProjectPoller now gates on windowIndices
    // (counting by index to survive duplicates), so clear that too.
    vi.mocked(windowExists).mockReturnValue(false);
    vi.mocked(windowIndices).mockReturnValue([]);
  });

  it("stops and respawns the usage poller", () => {
    restartLongLivedPollers("node /usr/local/bin/garden");

    expect(killWindowSafe).toHaveBeenCalledWith("_garden-usage-poller");
    const newWindowCalls = vi.mocked(newDashboardWindow).mock.calls;
    const windowNames = newWindowCalls.map(c => c[0] as string);
    expect(windowNames).toContain("_garden-usage-poller");
  });

  it("restarts every project poller whose registry has live workers", () => {
    registryMock._setEntries("alpha", [makeWorker({ name: "bold-ash" })]);
    registryMock._setEntries("beta",  [makeWorker({ name: "hot-moss" })]);

    restartLongLivedPollers("node /usr/local/bin/garden");

    // Project pollers tear down via killWindowsByName (kills any duplicates by
    // index); the usage poller still uses killWindowSafe.
    expect(killWindowsByName).toHaveBeenCalledWith("_alpha-poller");
    expect(killWindowsByName).toHaveBeenCalledWith("_beta-poller");

    const newWindowCalls = vi.mocked(newDashboardWindow).mock.calls;
    const windowNames = newWindowCalls.map(c => c[0] as string);
    expect(windowNames).toContain("_alpha-poller");
    expect(windowNames).toContain("_beta-poller");
  });

  it("skips projects that have no live workers", () => {
    registryMock._setEntries("alpha", []);

    restartLongLivedPollers("node /usr/local/bin/garden");

    expect(killWindowsByName).not.toHaveBeenCalledWith("_alpha-poller");
  });

  it("keeps going when an individual poller restart throws", () => {
    registryMock._setEntries("alpha", [makeWorker({ name: "bold-ash" })]);
    registryMock._setEntries("beta",  [makeWorker({ name: "hot-moss" })]);
    // throw on alpha's teardown so beta still gets restarted.
    vi.mocked(killWindowsByName).mockImplementation((name: string) => {
      if (name === "_alpha-poller") throw new Error("tmux gone");
      return 0;
    });

    expect(() => restartLongLivedPollers("node /usr/local/bin/garden")).not.toThrow();
    expect(killWindowsByName).toHaveBeenCalledWith("_beta-poller");
  });
});

describe("startProjectPoller — window convergence", () => {
  beforeEach(() => {
    vi.mocked(tryGetProject).mockReturnValue(
      { path: "/repo/solo" } as ReturnType<typeof tryGetProject>);
  });

  const newWindowNames = () =>
    vi.mocked(newDashboardWindow).mock.calls.map(c => c[0]);

  it("spawns a poller window when none exists", () => {
    vi.mocked(windowIndices).mockReturnValue([]);
    startProjectPoller("solo", "node /usr/local/bin/garden");
    expect(newWindowNames()).toContain("_solo-poller");
    expect(dedupeWindows).not.toHaveBeenCalled();
  });

  it("no-ops when exactly one poller window is live", () => {
    vi.mocked(windowIndices).mockReturnValue([7]);
    startProjectPoller("solo", "node /usr/local/bin/garden");
    expect(newWindowNames()).toHaveLength(0);
    expect(dedupeWindows).not.toHaveBeenCalled();
  });

  it("collapses duplicates instead of spawning another (the runaway-loop fix)", () => {
    vi.mocked(windowIndices).mockReturnValue([7, 12, 19]);
    startProjectPoller("solo", "node /usr/local/bin/garden");
    expect(dedupeWindows).toHaveBeenCalledWith("_solo-poller");
    expect(newWindowNames()).toHaveLength(0);
  });

  // The duplicate-window race: two independent processes (watchdog heal,
  // post-rebuild restart, validate-on-attach, worker create) each run the
  // windowIndices check-then-spawn. windowIndices is a snapshot, not a claim,
  // so both can see zero windows and both spawn. The mkfifo election doesn't
  // serialize them — the FIFO file persists after an unclean poller death, so
  // the respawn case skips the election entirely. The fix wraps the whole
  // check-and-spawn in a per-project file lock; the second caller acquires it
  // only after the first's new-window registered, sees one window, and no-ops.
  // A true cross-process interleave isn't reproducible in single-process
  // vitest, so this pins the mechanism: the spawn happens inside the lock.
  it("runs the check-and-spawn inside the per-project spawn lock", () => {
    vi.mocked(windowIndices).mockReturnValue([]);

    startProjectPoller("solo", "node /usr/local/bin/garden");

    const lockOpenIdx = vi.mocked(fs.openSync).mock.calls.findIndex(
      c => String(c[0]).includes("solo-poller.spawn.lock"),
    );
    expect(lockOpenIdx).toBeGreaterThanOrEqual(0);

    // new-window must fall between the lock's acquire (openSync) and release
    // (unlinkSync of the lock file) — proving the spawn is serialized.
    const lockUnlinkIdx = vi.mocked(fs.unlinkSync).mock.calls.findIndex(
      c => String(c[0]).includes("solo-poller.spawn.lock"),
    );
    const spawnIdx = vi.mocked(newDashboardWindow).mock.calls.findIndex(c => String(c[0]).includes("poller"));
    expect(spawnIdx).toBeGreaterThanOrEqual(0);

    const acquireOrder = vi.mocked(fs.openSync).mock.invocationCallOrder[lockOpenIdx];
    const spawnOrder = vi.mocked(newDashboardWindow).mock.invocationCallOrder[spawnIdx];
    const releaseOrder = vi.mocked(fs.unlinkSync).mock.invocationCallOrder[lockUnlinkIdx];
    expect(acquireOrder).toBeLessThan(spawnOrder);
    expect(spawnOrder).toBeLessThan(releaseOrder);
  });
});

describe("claude-code adapter isTransientError", () => {
  // Pure detector — no fs/tmux/registry interaction. Moved onto the harness
  // adapter (the error shapes are Anthropic's); tests live here rather
  // than a dedicated file so the module's existing mocks don't need to be
  // duplicated. See poller-review.ts handleTransientReviewFailure.
  it("matches a 500 Internal server error tail", async () => {
    const { claudeCodeAdapter } = await import("../src/dashboard/harness/claude-code.js");
    const isTransientReviewFailureTail = claudeCodeAdapter.isTransientError;
    const output = [
      "Looking at the diff...",
      "Everything looks reasonable here.",
      "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.",
    ].join("\n");
    expect(isTransientReviewFailureTail(output)).toBe(true);
  });

  it("matches a 529 overloaded_error JSON tail", async () => {
    const { claudeCodeAdapter } = await import("../src/dashboard/harness/claude-code.js");
    const isTransientReviewFailureTail = claudeCodeAdapter.isTransientError;
    const output = `Some reviewer body text.\nAPI Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;
    expect(isTransientReviewFailureTail(output)).toBe(true);
  });

  it("matches a 429 rate_limit_error tail", async () => {
    const { claudeCodeAdapter } = await import("../src/dashboard/harness/claude-code.js");
    const isTransientReviewFailureTail = claudeCodeAdapter.isTransientError;
    const output = `API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}`;
    expect(isTransientReviewFailureTail(output)).toBe(true);
  });

  it("does not match a reviewer that merely mentions API errors in body text", async () => {
    const { claudeCodeAdapter } = await import("../src/dashboard/harness/claude-code.js");
    const isTransientReviewFailureTail = claudeCodeAdapter.isTransientError;
    // The line is in the middle, not the tail. The verdict line at the bottom
    // would have been parsed in the normal path; only unparsed output reaches
    // this detector, and we don't want body-text false positives.
    const output = [
      "The error handling for API Error: 500 looks fine to me.",
      "Tests pass.",
      "Body continues for many lines after this.",
      "Line 4",
      "Line 5",
      "Line 6",
      "Some closing thought without a verdict token.",
    ].join("\n");
    expect(isTransientReviewFailureTail(output)).toBe(false);
  });

  it("does not match a 4xx that isn't rate-limit (e.g. 400 bad request)", async () => {
    const { claudeCodeAdapter } = await import("../src/dashboard/harness/claude-code.js");
    const isTransientReviewFailureTail = claudeCodeAdapter.isTransientError;
    // 400/401/403/404 indicate operator-action failures (auth, malformed
    // request) — auto-retry would just burn the budget. The detector is
    // scoped to 5xx and 429.
    const output = `API Error: 400 Bad Request`;
    expect(isTransientReviewFailureTail(output)).toBe(false);
  });

  it("does not match empty or whitespace-only output", async () => {
    const { claudeCodeAdapter } = await import("../src/dashboard/harness/claude-code.js");
    const isTransientReviewFailureTail = claudeCodeAdapter.isTransientError;
    expect(isTransientReviewFailureTail("")).toBe(false);
    expect(isTransientReviewFailureTail("   \n  \n")).toBe(false);
  });
});
