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
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject", checks: null })),
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
  deleteRemoteBranch: vi.fn(),
  fastForwardMain: vi.fn(),
  getChangedFiles: vi.fn(() => []),
  getCommitSummary: vi.fn(() => "abc123 fix something"),
  getNewCommitSummary: vi.fn(() => "def456 address review feedback"),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "test rules"),
}));

import { poll, postPush } from "../src/dashboard/poller.js";
import { tryGetProject } from "../src/config.js";
import { updateWorkerFields, getWorkers } from "../src/dashboard/registry.js";
import {
  getBranchHeadSha,
  forcePushBranch, mergeToMain,
  getChangedFiles, getCommitSummary, getNewCommitSummary, getDiffAgainstMain,
} from "../src/dashboard/git.js";
import { refreshDashboard } from "../src/dashboard/header.js";
import { tmux, hasClaudeChild, isClaudeWorking, getPanePid, windowExists, getFirstPaneId } from "../src/dashboard/tmux.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { spawnSync } from "node:child_process";
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
  vi.mocked(spawnSync).mockReturnValue({
    status: 0, stdout: "Looks good.\nCLEAN", stderr: "",
  } as ReturnType<typeof spawnSync>);
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: undefined } as ReturnType<typeof tryGetProject>);
  vi.mocked(getBranchHeadSha).mockReturnValue("abc123");
  // Default: Claude not running, so review attempts proceed
  vi.mocked(hasClaudeChild).mockReturnValue(false);
});

describe("poll — working state", () => {
  it("detects new commits and transitions to reviewing", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll();

    expect(getBranchHeadSha).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "reviewing",
    });
    expect(refreshDashboard).toHaveBeenCalled();
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

  it("does not rebase or force-push during attemptReview", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll(); // working -> reviewing

    // attemptReview just sets state, no rebase or force-push
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "reviewing",
    });
  });
});

describe("poll — reviewing state", () => {
  it("merges when review returns CLEAN", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Looks good.\nCLEAN", stderr: "",
    } as never);

    poll();

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToMain).toHaveBeenCalledWith("/repo/myproject", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "merged",
      mergedAt: expect.any(String),
      failCount: 0,
    });
  });

  it("merges after fixing when review returns FIXED", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Added missing tests.\nFIXED", stderr: "",
    } as never);

    poll();

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToMain).toHaveBeenCalledWith("/repo/myproject", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "merged",
      mergedAt: expect.any(String),
      failCount: 0,
    });
  });

  it("transitions to failing when reviewer returns FAILED", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Fundamental architecture issue.\nFAILED", stderr: "",
    } as never);

    poll();

    expect(mergeToMain).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "failing",
      failCount: 1,
      failingSha: "abc123",
      lastSeenSha: "abc123",
      lastShaChangeAt: expect.any(String),
    });
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "review",
        worker: "bold-ash",
      }),
    );
  });

  it("transitions to failing and adds alert when review process fails", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 1, stdout: "", stderr: "claude not found",
    } as never);

    poll();

    expect(mergeToMain).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "failing",
      failCount: 1,
      lastSeenSha: "abc123",
      lastShaChangeAt: expect.any(String),
    });
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "review",
        project: "myproject",
        worker: "bold-ash",
      }),
    );
  });

  it("transitions to failing when review verdict is unparseable", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Not sure about this one.\nMAYBE", stderr: "",
    } as never);

    poll();

    expect(mergeToMain).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", source: "review" }),
    );
  });

  it("resets to working when Claude becomes active during review", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(isClaudeWorking).mockReturnValue(true);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "working",
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(mergeToMain).not.toHaveBeenCalled();
  });

  it("full cycle: working -> reviewing -> merged", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll(); // working -> reviewing

    expect(forcePushBranch).not.toHaveBeenCalled();

    poll(); // reviewing -> merged

    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergeToMain).toHaveBeenCalledWith("/repo/myproject", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "merged",
      mergedAt: expect.any(String),
      failCount: 0,
    });
  });
});

describe("poll — reviewer prompt", () => {
  it("includes rebase instructions", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);

    poll();

    expect(spawnSync).toHaveBeenCalledWith(
      "claude",
      ["-p", "--dangerously-skip-permissions"],
      expect.objectContaining({
        input: expect.stringContaining("git rebase main"),
      }),
    );
  });

  it("includes checks command when configured", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: "npm test",
    } as ReturnType<typeof tryGetProject>);

    poll();

    const input = vi.mocked(spawnSync).mock.calls[0][2]?.input as string;
    expect(input).toContain("npm test");
    expect(input).toContain("Run checks");
  });

  it("omits checks step when not configured", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: undefined,
    } as ReturnType<typeof tryGetProject>);

    poll();

    const input = vi.mocked(spawnSync).mock.calls[0][2]?.input as string;
    expect(input).not.toContain("Run checks");
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

    // Should not have updated prState since SHA is same and debounce hasn't elapsed
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

describe("poll — merge serialization", () => {
  it("skips review when another worker is already reviewing", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ name: "calm-bay", prState: "reviewing", sessionId: "s1", task: "t1" }),
      makeWorker({ name: "bold-ash", prState: "working", sessionId: "s2", task: "t2" }),
    ]);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");
    // Prevent calm-bay's review from running (Claude active guard)
    vi.mocked(isClaudeWorking).mockReturnValue(true);

    poll();

    // bold-ash should not have attempted review (serialization guard)
    // calm-bay should not have reviewed (Claude active guard)
    expect(forcePushBranch).not.toHaveBeenCalled();
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
    // isClaudeWorking defaults to false — review should proceed

    poll(); // working -> reviewing
    poll(); // reviewing -> merged

    expect(forcePushBranch).toHaveBeenCalled();
    expect(mergeToMain).toHaveBeenCalled();
  });
});

describe("postPush", () => {
  it("is a simple trigger", () => {
    // postPush just calls triggerPoll, which writes to the FIFO
    // Since FIFO isn't set up in tests, it should not throw
    expect(() => postPush()).not.toThrow();
  });
});

describe("poll — sibling merge notification", () => {
  it("notifies sibling worker when files overlap after merge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "working",
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
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll(); // working -> reviewing

    // Set up getChangedFiles for the review+merge+notification cycle:
    // 1st call: runClaudeReview test file lookup
    // 2nd call: notifySiblingWorkers — merged worker's files
    // 3rd call: notifySiblingWorkers — sibling's files
    vi.mocked(getChangedFiles)
      .mockReturnValueOnce([])                            // review: test file lookup
      .mockReturnValueOnce(["src/foo.ts", "src/bar.ts"])  // merged worker
      .mockReturnValueOnce(["src/foo.ts", "src/baz.ts"]); // sibling

    // Sibling needs Claude alive for delivery
    vi.mocked(hasClaudeChild).mockReturnValue(true);

    poll(); // reviewing -> merged (with sibling notification)

    // Verify sibling was notified via send-keys
    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5", "-l",
      expect.stringContaining("src/foo.ts"),
    );
  });

  it("does not notify sibling when no file overlap", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "working",
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
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll(); // working -> reviewing

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce([])             // review: test file lookup
      .mockReturnValueOnce(["src/foo.ts"]) // merged worker
      .mockReturnValueOnce(["src/bar.ts"]); // sibling — no overlap

    poll(); // reviewing -> merged

    // mergeToMain should be called (merge happens) but no sibling notification
    expect(mergeToMain).toHaveBeenCalled();
    // Only send-keys calls should be for the merge flow, not sibling notification
    const sendKeyCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "send-keys" && typeof c[3] === "string" && c[3].includes("overlap"),
    );
    expect(sendKeyCalls).toHaveLength(0);
  });

  it("skips dead sibling instead of relaunching", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "working",
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

    // Claude not running in either worker
    vi.mocked(hasClaudeChild).mockReturnValue(false);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");

    poll(); // working -> reviewing

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce([])              // review: test file lookup
      .mockReturnValueOnce(["src/foo.ts"])   // merged worker
      .mockReturnValueOnce(["src/foo.ts"]);  // sibling — overlap

    poll(); // reviewing -> merged (sibling is dead, should be skipped)

    // Should NOT have relaunched or set pending notification
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
        prState: "working",
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

    vi.mocked(hasClaudeChild).mockReturnValue(false);
    vi.mocked(getBranchHeadSha).mockReturnValue("new-sha");
    // Return files only for bold-ash; calm-bay has no new commits
    vi.mocked(getChangedFiles).mockReturnValue(["src/foo.ts"]);
    vi.mocked(getCommitSummary).mockImplementation((wtPath: string) => {
      if (wtPath.includes("calm-bay")) return "";  // no new commits — stay merged
      return "abc123 fix something";
    });

    poll(); // bold-ash: working -> reviewing; calm-bay: stays merged (no commits)
    poll(); // bold-ash: reviewing -> merged

    // Sibling notification filters out "merged" workers, so calm-bay
    // should not have getChangedFiles called for overlap detection.
    // getChangedFiles is called for bold-ash's review (test file lookup)
    // and for bold-ash's sibling notification (merged worker's files).
    const changedFilesCalls = vi.mocked(getChangedFiles).mock.calls;
    const calmBayCalls = changedFilesCalls.filter(c => c[0] === "/tmp/wt/myproject/calm-bay");
    expect(calmBayCalls).toHaveLength(0);
  });
});

describe("poll — alerts", () => {
  it("adds alert on merge failure", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing" }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Looks good.\nCLEAN", stderr: "",
    } as never);
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
      makeWorker({ prState: "reviewing", failCount: 2 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Looks good.\nCLEAN", stderr: "",
    } as never);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged", failCount: 0 }),
    );
  });

  it("increments failCount when reviewer cannot fix issues", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", failCount: 1 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Fundamental issue.\nFAILED", stderr: "",
    } as never);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing", failCount: 2 }),
    );
  });
});
