import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync, execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "Looks good.\nCLEAN", stderr: "" })),
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
  getPanePid: vi.fn(() => "12345"),
  hasClaudeChild: vi.fn(() => true),
  isClaudeWorking: vi.fn(() => false),
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
    _setEntries: (project: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[project] = list;
    },
    _clear: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
  };
});

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
  getDiffAgainstMain: vi.fn(() => "diff --git a/file.ts b/file.ts"),
  forcePushBranch: vi.fn(),
  mergeToMain: vi.fn(),
  rebaseBranch: vi.fn(() => true),
  abortRebase: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  fastForwardMain: vi.fn(),
  getChangedFiles: vi.fn(() => []),
  getCommitSummary: vi.fn(() => "abc123 fix something"),
  getNewCommitSummary: vi.fn(() => "def456 address review feedback"),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "test rules"),
}));

import fs from "node:fs";
import { poll, postPush } from "../src/dashboard/poller.js";
import { tryGetProject } from "../src/config.js";
import { updateWorkerFields, getWorkers } from "../src/dashboard/registry.js";
import {
  getBranchHeadSha,
  forcePushBranch, mergeToMain, rebaseBranch, abortRebase,
  getChangedFiles, getCommitSummary, getNewCommitSummary, getDiffAgainstMain,
} from "../src/dashboard/git.js";
import { refreshDashboard } from "../src/dashboard/header.js";
import { tmux, hasClaudeChild, isClaudeWorking, getPanePid, windowExists, getFirstPaneId } from "../src/dashboard/tmux.js";
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
  vi.mocked(getPanePid).mockReturnValue("12345");
  vi.mocked(getChangedFiles).mockReturnValue([]);
  vi.mocked(getDiffAgainstMain).mockReturnValue("diff --git a/file.ts b/file.ts");
  vi.mocked(getCommitSummary).mockReturnValue("abc123 fix something");
  vi.mocked(getNewCommitSummary).mockReturnValue("def456 address review feedback");
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: undefined } as ReturnType<typeof tryGetProject>);
  vi.mocked(getBranchHeadSha).mockReturnValue("abc123");
  vi.mocked(rebaseBranch).mockReturnValue(true);
  // Default: Claude not running, so review attempts proceed
  vi.mocked(hasClaudeChild).mockReturnValue(false);
  // Default: fs.existsSync returns false
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe("poll — working state", () => {
  it("detects new commits and launches review", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll();

    expect(getBranchHeadSha).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    // Should write prompt file and launch review window
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

  it("does nothing when no new commits", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", lastSeenSha: "abc123" }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("abc123");

    poll();

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("does nothing when Claude is actively working", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");
    vi.mocked(isClaudeWorking).mockReturnValue(true);

    poll();

    expect(forcePushBranch).not.toHaveBeenCalled();
  });

  it("does nothing when no commits ahead of main", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");
    vi.mocked(getCommitSummary).mockReturnValue("");

    poll();

    expect(forcePushBranch).not.toHaveBeenCalled();
  });

  it("allows multiple workers to review simultaneously", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ name: "calm-bay", prState: "reviewing", sessionId: "s1", task: "t1",
        reviewWindowName: "_myproject-review-calm-bay" }),
      makeWorker({ name: "bold-ash", prState: "working", sessionId: "s2", task: "t2" }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll();

    // bold-ash should still launch review even though calm-bay is reviewing
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });
});

describe("poll — reviewing state (async)", () => {
  it("returns false while review window is still running", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
    ]);
    // Review window still exists
    vi.mocked(windowExists).mockImplementation((name: string) => true);

    const changed = poll();

    // Should not process result yet
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergeToMain).not.toHaveBeenCalled();
  });

  it("transitions to merge-pending when review returns CLEAN", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
    ]);
    // Review window is gone (review completed)
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    // Result file exists with CLEAN verdict
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Looks good.\nCLEAN";
      return "{}";
    });

    poll();

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "merge-pending",
        mergePendingAt: expect.any(String),
        lastReviewBody: "Looks good.",
        reviewWindowName: undefined,
      }),
    );
  });

  it("transitions to merge-pending when review returns FIXED", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
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

    poll();

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );
  });

  it("logs summary for fixed verdicts", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
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

    poll();

    expect(log.info).toHaveBeenCalledWith("poller", "review complete", {
      worker: "bold-ash",
      verdict: "fixed",
      summary: "Added missing tests.",
    });
  });

  it("does not log summary for clean verdicts", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
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

    poll();

    expect(log.info).toHaveBeenCalledWith("poller", "review complete", {
      worker: "bold-ash",
      verdict: "clean",
    });
  });

  it("resets to working when force-push fails after review", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
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

    poll();

    expect(mergeToMain).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working", reviewWindowName: undefined }),
    );
  });

  it("transitions to failing when reviewer returns FAILED", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
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

    poll();

    expect(mergeToMain).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        failingSha: "abc123",
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

  it("transitions to failing when review result is missing", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
    ]);
    // Review window gone, but no result file
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockReturnValue(false);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "failing",
        failCount: 1,
        reviewWindowName: undefined,
      }),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", source: "review" }),
    );
  });

  it("transitions to failing when review verdict is unparseable", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
    ]);
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("-review-"),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).includes("review-result"),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).includes("review-result")) return "Not sure about this one.\nMAYBE";
      return "{}";
    });

    poll();

    expect(mergeToMain).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing", reviewWindowName: undefined }),
    );
  });

  it("resets to working when Claude becomes active during review", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", reviewWindowName: "_myproject-review-bold-ash" }),
    ]);
    vi.mocked(isClaudeWorking).mockReturnValue(true);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working", reviewWindowName: undefined }),
    );
    expect(mergeToMain).not.toHaveBeenCalled();
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
    vi.mocked(rebaseBranch).mockReturnValue(true);

    poll();

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "bold-ash");
    expect(mergeToMain).toHaveBeenCalledWith("/repo/myproject", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({
        prState: "merged",
        mergedAt: expect.any(String),
        failCount: 0,
        mergePendingAt: undefined,
      }),
    );
  });

  it("launches re-review when rebase has conflicts", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastReviewBody: "Code looks good.",
        task: "fix the bug",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(false);

    poll();

    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToMain).not.toHaveBeenCalled();
    // Should launch a re-review
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

  it("includes previous review body in re-review prompt", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
        lastReviewBody: "Code is well structured.",
        task: "add retry logic",
      }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(false);

    poll();

    // Check prompt file content
    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(promptCall).toBeDefined();
    const promptContent = String(promptCall![1]);
    expect(promptContent).toContain("previously reviewed and approved");
    expect(promptContent).toContain("Code is well structured.");
    expect(promptContent).toContain("add retry logic");
  });

  it("merges earliest merge-pending first, then next can proceed", () => {
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

    poll();

    // calm-bay merges first (earlier timestamp), then bold-ash can proceed
    const mergeCalls = vi.mocked(mergeToMain).mock.calls;
    expect(mergeCalls[0]).toEqual(["/repo/myproject", "calm-bay"]);
  });

  it("resets to working when force-push fails", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(forcePushBranch).mockImplementation(() => { throw new Error("push failed"); });

    poll();

    expect(mergeToMain).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working", mergePendingAt: undefined }),
    );
  });

  it("adds alert on merge failure", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    vi.mocked(mergeToMain).mockImplementation(() => { throw new Error("merge conflict"); });

    poll();

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "poller",
        project: "myproject",
        message: expect.stringContaining("Merge failed"),
      }),
    );
  });
});

describe("poll — reviewer prompt", () => {
  it("includes rebase instructions", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll();

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(promptCall).toBeDefined();
    expect(String(promptCall![1])).toContain("git rebase main");
  });

  it("includes checks command when configured", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: "npm test",
    } as ReturnType<typeof tryGetProject>);

    poll();

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    const content = String(promptCall![1]);
    expect(content).toContain("npm test");
    expect(content).toContain("Run checks");
  });

  it("omits checks step when not configured", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: undefined,
    } as ReturnType<typeof tryGetProject>);

    poll();

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(String(promptCall![1])).not.toContain("Run checks");
  });

  it("includes worker task in prompt", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "working", task: "refactor the dashboard" }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll();

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const promptCall = writeFileCalls.find(c =>
      String(c[0]).includes("review-prompt"),
    );
    expect(String(promptCall![1])).toContain("refactor the dashboard");
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

    poll();

    expect(getNewCommitSummary).toHaveBeenCalledWith(
      "/tmp/wt/myproject/bold-ash", "old-sha",
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      lastSeenSha: "new-sha",
      lastShaChangeAt: expect.any(String),
    });
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

    poll();

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("transitions back to working after debounce for transient failures (no failingSha)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("abc123");

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "working",
      failingSha: undefined,
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

    poll();

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("retries after new commits and debounce when failingSha is set", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        failingSha: "old-sha",
        lastSeenSha: "new-sha",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "working",
      failingSha: undefined,
    });
  });
});

describe("poll — live-Claude guard", () => {
  it("skips review when Claude is actively working in worktree", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");
    vi.mocked(isClaudeWorking).mockReturnValue(true);

    poll();

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergeToMain).not.toHaveBeenCalled();
  });

  it("proceeds with review when Claude is not working", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll(); // working -> reviewing (launches review window)

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "reviewing" }),
    );
  });
});

describe("poll — full cycle", () => {
  it("working -> reviewing -> merge-pending -> merged", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll(); // working -> reviewing (launches review window)

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "reviewing" }),
    );

    // Simulate review completion
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

    poll(); // reviewing -> merge-pending

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merge-pending" }),
    );

    poll(); // merge-pending -> merged

    expect(mergeToMain).toHaveBeenCalledWith("/repo/myproject", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged" }),
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
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce(["src/foo.ts", "src/bar.ts"])  // merged worker
      .mockReturnValueOnce(["src/foo.ts", "src/baz.ts"]); // sibling

    vi.mocked(hasClaudeChild).mockReturnValue(true);

    poll(); // merge-pending -> merged (with sibling notification)

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
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce(["src/foo.ts"]) // merged worker
      .mockReturnValueOnce(["src/bar.ts"]); // sibling — no overlap

    poll();

    expect(mergeToMain).toHaveBeenCalled();
    const sendKeyCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "send-keys" && typeof c[3] === "string" && c[3].includes("overlap"),
    );
    expect(sendKeyCalls).toHaveLength(0);
  });

  it("skips dead sibling instead of relaunching", () => {
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
        sessionId: "s2",
        task: "t2",
        worktreePath: "/tmp/wt/myproject/calm-bay",
        branchName: "calm-bay",
      }),
    ]);

    vi.mocked(hasClaudeChild).mockReturnValue(false);
    vi.mocked(getChangedFiles)
      .mockReturnValueOnce(["src/foo.ts"])   // merged worker
      .mockReturnValueOnce(["src/foo.ts"]);  // sibling — overlap

    poll();

    // Should NOT have relaunched
    const updateCalls = vi.mocked(updateWorkerFields).mock.calls.filter(
      c => c[1] === "calm-bay",
    );
    const relaunchCalls = updateCalls.filter(
      c => "sessionId" in (c[2] as Record<string, unknown>),
    );
    expect(relaunchCalls).toHaveLength(0);
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

    poll();

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

    poll();

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("failed 3 times"),
      }),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "working",
      failingSha: undefined,
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

    poll();

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

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged", failCount: 0 }),
    );
  });

  it("increments failCount when reviewer cannot fix issues", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "reviewing",
        failCount: 1,
        reviewWindowName: "_myproject-review-bold-ash",
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

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing", failCount: 2 }),
    );
  });
});
