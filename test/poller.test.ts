import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync, execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "APPROVE\nLooks good.", stderr: "" })),
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
  getBranchPR: vi.fn(() => null),
  getPRInfo: vi.fn(() => ({ state: "OPEN", headSha: "abc123" })),
  rebaseBranch: vi.fn(() => true),
  abortRebase: vi.fn(),
  forcePushBranch: vi.fn(),
  mergePR: vi.fn(),
  commentOnPR: vi.fn(),
  fastForwardMain: vi.fn(),
  getChangedFiles: vi.fn(() => []),
  getPRDetails: vi.fn(() => null),
  getPRDiff: vi.fn(() => "diff --git a/file.ts b/file.ts"),
  submitPRReview: vi.fn(() => true),
  createPR: vi.fn(() => 99),
  getCommitSummary: vi.fn(() => "abc123 fix something"),
  getNewCommitSummary: vi.fn(() => "def456 address review feedback"),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "test rules"),
}));

vi.mock("../src/dashboard/create.js", () => ({
  buildWorktreeWorkerCommand: vi.fn(() => "claude --dangerously-skip-permissions --session-id fake-id"),
}));

vi.mock("node:crypto", () => ({
  default: { randomUUID: vi.fn(() => "new-uuid-123") },
}));

import { poll, postPush } from "../src/dashboard/poller.js";
import { tryGetProject } from "../src/config.js";
import { updateWorkerFields, getWorkers } from "../src/dashboard/registry.js";
import {
  getBranchPR, getPRInfo, rebaseBranch, abortRebase,
  forcePushBranch, mergePR, commentOnPR,
  getChangedFiles, getPRDetails, submitPRReview,
  createPR, getCommitSummary, getNewCommitSummary, getPRDiff,
} from "../src/dashboard/git.js";
import { buildWorktreeWorkerCommand } from "../src/dashboard/create.js";
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
  vi.mocked(getPRDetails).mockReturnValue(null);
  vi.mocked(getPRDiff).mockReturnValue("diff --git a/file.ts b/file.ts");
  vi.mocked(submitPRReview).mockReturnValue(true);
  vi.mocked(createPR).mockReturnValue(99);
  vi.mocked(getCommitSummary).mockReturnValue("abc123 fix something");
  vi.mocked(getNewCommitSummary).mockReturnValue("def456 address review feedback");
  vi.mocked(spawnSync).mockReturnValue({
    status: 0, stdout: "APPROVE\nLooks good.", stderr: "",
  } as ReturnType<typeof spawnSync>);
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: undefined } as ReturnType<typeof tryGetProject>);
  vi.mocked(rebaseBranch).mockReturnValue(true);
  vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });
  vi.mocked(getBranchPR).mockReturnValue(null);
  // Default: Claude not running, so merge attempts proceed
  vi.mocked(hasClaudeChild).mockReturnValue(false);
});

describe("poll — working state", () => {
  it("detects a new PR and transitions to open", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchPR).mockReturnValue(42);

    poll();

    expect(getBranchPR).toHaveBeenCalledWith("/repo/myproject", "bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prNumber: 42,
      prState: "open",
    });
    expect(refreshDashboard).toHaveBeenCalled();
  });

  it("does nothing when no PR exists yet", () => {
    registryMock._setEntries("myproject", [makeWorker({ prState: "working" })]);
    vi.mocked(getBranchPR).mockReturnValue(null);

    poll();

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});

describe("poll — open state, merge conflict", () => {
  it("aborts rebase and notifies worker on conflict", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(false);
    // Guard uses isClaudeWorking (default false = let merge proceed)
    // notifyWorker uses hasClaudeChild (true = Claude alive, deliver message)
    vi.mocked(hasClaudeChild).mockReturnValue(true);

    poll();

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(abortRebase).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(commentOnPR).toHaveBeenCalledWith(
      "/repo/myproject",
      42,
      expect.stringContaining("Merge conflict"),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "failing",
      failCount: 1,
      failingSha: "abc123",
      lastSeenSha: "abc123",
      lastShaChangeAt: expect.any(String),
    });
    // Notifies worker via tmux send-keys
    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5", "-l",
      expect.stringContaining("Merge conflict"),
    );
  });

  it("does not force-push or merge on conflict", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(false);

    poll();

    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergePR).not.toHaveBeenCalled();
  });
});

describe("poll — open state, successful merge", () => {
  it("rebases, force-pushes, and transitions to reviewing", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(true);

    poll();

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "reviewing",
    });
    // mergePR happens on the next cycle after review
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("merges after review approves on second poll cycle", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(true);

    poll(); // open -> reviewing
    poll(); // reviewing -> merged

    expect(mergePR).toHaveBeenCalledWith("/repo/myproject", 42);
    expect(submitPRReview).toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "merged",
      mergedAt: expect.any(String),
      failCount: 0,
    });
  });
});

describe("poll — open state with checks", () => {
  it("transitions to failing when checks fail after rebase", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: "npm test",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("tests failed"), { stderr: Buffer.from("FAIL src/foo.test.ts") });
    });

    poll();

    // Rebase happens before checks now
    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(execSync).toHaveBeenCalledWith(
      "npm test",
      expect.objectContaining({ cwd: "/tmp/wt/myproject/bold-ash" }),
    );
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergePR).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "failing",
      failCount: 1,
      failingSha: "abc123",
      lastSeenSha: "abc123",
      lastShaChangeAt: expect.any(String),
    });
  });

  it("runs checks after rebase and transitions to reviewing when both pass", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: "npm test",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(rebaseBranch).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue("" as never);

    poll();

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(execSync).toHaveBeenCalledWith(
      "npm test",
      expect.objectContaining({ cwd: "/tmp/wt/myproject/bold-ash" }),
    );
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "reviewing",
    });
  });
});

describe("poll — reviewing state", () => {
  it("merges when review approves", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "APPROVE\nLooks good.", stderr: "",
    } as never);

    poll();

    expect(submitPRReview).toHaveBeenCalledWith("/repo/myproject", 42, true, "Looks good.");
    expect(commentOnPR).toHaveBeenCalledWith(
      "/repo/myproject", 42,
      "[garden] **Review: Approved**\n\nLooks good.",
    );
    expect(mergePR).toHaveBeenCalledWith("/repo/myproject", 42);
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "merged",
      mergedAt: expect.any(String),
      failCount: 0,
    });
  });

  it("transitions to failing when review requests changes", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "REQUEST_CHANGES\nMissing tests for new function.", stderr: "",
    } as never);
    // Guard uses isClaudeWorking (default false); notification needs Claude alive
    vi.mocked(hasClaudeChild).mockReturnValue(true);

    poll();

    expect(submitPRReview).toHaveBeenCalledWith(
      "/repo/myproject", 42, false, "Missing tests for new function.",
    );
    expect(commentOnPR).toHaveBeenCalledWith(
      "/repo/myproject", 42,
      "[garden] **Review: Changes requested**\n\nMissing tests for new function.",
    );
    expect(mergePR).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "failing",
      failCount: 1,
      failingSha: "abc123",
      lastSeenSha: "abc123",
      lastShaChangeAt: expect.any(String),
    });
  });

  it("transitions to failing and adds alert when review process fails", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 1, stdout: "", stderr: "claude not found",
    } as never);

    poll();

    expect(submitPRReview).not.toHaveBeenCalled();
    expect(mergePR).not.toHaveBeenCalled();
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
        prNumber: 42,
      }),
    );
  });

  it("transitions to failing when review verdict is unparseable", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "MAYBE\nNot sure about this one.", stderr: "",
    } as never);

    poll();

    expect(mergePR).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing" }),
    );
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", source: "review" }),
    );
  });

  it("resets to open when Claude becomes active during review", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42 }),
    ]);
    vi.mocked(isClaudeWorking).mockReturnValue(true);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "open",
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(mergePR).not.toHaveBeenCalled();
  });
});

describe("poll — failing state", () => {
  it("resets debounce and posts commit summary when SHA changes", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        prNumber: 42,
        failingSha: "old-sha",
        lastSeenSha: "old-sha",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "new-sha" });

    poll();

    expect(getNewCommitSummary).toHaveBeenCalledWith(
      "/tmp/wt/myproject/bold-ash", "old-sha",
    );
    expect(commentOnPR).toHaveBeenCalledWith(
      "/repo/myproject", 42,
      expect.stringContaining("pushed new commits"),
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
        prNumber: 42,
        failingSha: "abc123",
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });

    poll();

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("transitions back to open after debounce for transient failures (no failingSha)", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        prNumber: 42,
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "open",
      failingSha: undefined,
    });
  });

  it("stays in failing if debounce not elapsed", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        prNumber: 42,
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date().toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });

    poll();

    // Should not have updated prState since SHA is same and debounce hasn't elapsed
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("retries after new commits and debounce when failingSha is set", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        prNumber: 42,
        failingSha: "old-sha",
        lastSeenSha: "new-sha",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "new-sha" });

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "open",
      failingSha: undefined,
    });
  });
});

describe("poll — externally closed PR", () => {
  it("transitions to merged when PR is closed externally", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "MERGED", headSha: "abc123" });

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "merged",
      mergedAt: expect.any(String),
    });
    // Should not attempt rebase/merge since PR is already merged
    expect(rebaseBranch).not.toHaveBeenCalled();
  });
});

describe("poll — merge serialization", () => {
  it("skips merge when another worker is already merging", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ name: "calm-bay", prState: "merging", prNumber: 10, sessionId: "s1", task: "t1" }),
      makeWorker({ name: "bold-ash", prState: "open", prNumber: 42, sessionId: "s2", task: "t2" }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });

    poll();

    // bold-ash should not have attempted merge
    expect(mergePR).not.toHaveBeenCalled();
    expect(forcePushBranch).not.toHaveBeenCalled();
  });
});

describe("poll — live-Claude guard", () => {
  it("skips merge when Claude is actively working in worktree", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(isClaudeWorking).mockReturnValue(true);

    poll();

    expect(rebaseBranch).not.toHaveBeenCalled();
    expect(forcePushBranch).not.toHaveBeenCalled();
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("proceeds with merge when Claude is not working", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    // isClaudeWorking defaults to false — merge should proceed

    poll(); // open -> reviewing
    poll(); // reviewing -> merged

    expect(rebaseBranch).toHaveBeenCalled();
    expect(forcePushBranch).toHaveBeenCalled();
    expect(mergePR).toHaveBeenCalled();
  });
});

describe("postPush — follow-up PR creation", () => {
  it("creates follow-up PR when branch has merged PR and unmerged commits", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merged",
        prNumber: 42,
        mergedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    // Mock cwd to match worktree path
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/wt/myproject/bold-ash");
    // rev-list returns 1 unmerged commit
    vi.mocked(execFileSync).mockReturnValue("1" as never);
    vi.mocked(createPR).mockReturnValue(99);

    postPush();

    expect(createPR).toHaveBeenCalledWith(
      "/repo/myproject",
      "bold-ash",
      expect.stringContaining("continued"),
      expect.stringContaining("Follow-up"),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "open", prNumber: 99 }),
    );
    cwdSpy.mockRestore();
  });

  it("falls back to working if PR creation fails", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "merged",
        prNumber: 42,
        mergedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/wt/myproject/bold-ash");
    vi.mocked(execFileSync).mockReturnValue("1" as never);
    vi.mocked(createPR).mockReturnValue(null);

    postPush();

    expect(createPR).toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "working" }),
    );
    cwdSpy.mockRestore();
  });

  it("only signals poller when no merged PR exists", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/wt/myproject/bold-ash");

    postPush();

    expect(createPR).not.toHaveBeenCalled();
    cwdSpy.mockRestore();
  });
});

describe("poll — sibling merge notification", () => {
  it("notifies sibling worker when files overlap after merge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "open",
        prNumber: 42,
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
    vi.mocked(rebaseBranch).mockReturnValue(true);

    vi.mocked(getPRDetails).mockReturnValue({
      title: "fix: normalize output",
      url: "https://github.com/org/repo/pull/42",
    });

    poll(); // open -> reviewing

    // Set up getChangedFiles for the review+merge+notification cycle:
    // 1st call: runClaudeReview test file lookup
    // 2nd call: notifySiblingWorkers — merged worker's files
    // 3rd call: notifySiblingWorkers — sibling's files
    vi.mocked(getChangedFiles)
      .mockReturnValueOnce([])                            // review: test file lookup
      .mockReturnValueOnce(["src/foo.ts", "src/bar.ts"])  // merged worker
      .mockReturnValueOnce(["src/foo.ts", "src/baz.ts"]); // sibling

    // Guard uses isClaudeWorking (default false); sibling needs Claude alive for delivery
    vi.mocked(hasClaudeChild).mockReturnValue(true);

    poll(); // reviewing -> merged (with sibling notification)

    // Verify sibling was notified via send-keys
    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5", "-l",
      expect.stringContaining("src/foo.ts"),
    );
    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5", "-l",
      expect.stringContaining("fix: normalize output"),
    );
  });

  it("does not notify sibling when no file overlap", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "open",
        prNumber: 42,
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
    vi.mocked(rebaseBranch).mockReturnValue(true);

    poll(); // open -> reviewing

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce([])             // review: test file lookup
      .mockReturnValueOnce(["src/foo.ts"]) // merged worker
      .mockReturnValueOnce(["src/bar.ts"]); // sibling — no overlap

    poll(); // reviewing -> merged

    // mergePR should be called (merge happens) but no sibling notification
    expect(mergePR).toHaveBeenCalled();
    // Only send-keys calls should be for the merge flow, not sibling notification
    const sendKeyCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "send-keys" && typeof c[3] === "string" && c[3].includes("overlap"),
    );
    expect(sendKeyCalls).toHaveLength(0);
  });

  it("relaunches dead sibling on overlap", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "open",
        prNumber: 42,
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

    vi.mocked(getPRDetails).mockReturnValue({
      title: "fix: something",
      url: "https://github.com/org/repo/pull/42",
    });

    // Claude not running in either worker
    vi.mocked(hasClaudeChild).mockReturnValue(false);
    vi.mocked(rebaseBranch).mockReturnValue(true);

    poll(); // open -> reviewing

    vi.mocked(getChangedFiles)
      .mockReturnValueOnce([])              // review: test file lookup
      .mockReturnValueOnce(["src/foo.ts"])   // merged worker
      .mockReturnValueOnce(["src/foo.ts"]);  // sibling — overlap

    poll(); // reviewing -> merged (with sibling relaunch)

    // Should have relaunched with new session and set pending notification
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "calm-bay",
      expect.objectContaining({
        sessionId: "new-uuid-123",
        pendingNotification: expect.stringContaining("src/foo.ts"),
      }),
    );
    expect(buildWorktreeWorkerCommand).toHaveBeenCalled();
  });

  it("skips notification for workers in merged state", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        name: "bold-ash",
        prState: "open",
        prNumber: 42,
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
    vi.mocked(rebaseBranch).mockReturnValue(true);
    vi.mocked(getChangedFiles).mockReturnValue(["src/foo.ts"]);

    poll(); // open -> reviewing
    poll(); // reviewing -> merged

    // getChangedFiles should only be called once (for the merged worker's sibling check)
    // not for calm-bay since it's in "merged" state
    const changedFilesCalls = vi.mocked(getChangedFiles).mock.calls;
    // One call from runClaudeReview (for test file lookup), one from notifySiblingWorkers
    const siblingCalls = changedFilesCalls.filter(c => c[0] === "/tmp/wt/myproject/bold-ash");
    expect(siblingCalls.length).toBeGreaterThanOrEqual(1);
    // calm-bay should NOT have getChangedFiles called (it's merged)
    const calmBayCalls = changedFilesCalls.filter(c => c[0] === "/tmp/wt/myproject/calm-bay");
    expect(calmBayCalls).toHaveLength(0);
  });
});

describe("poll — pending notification delivery", () => {
  it("delivers pending notification when Claude is alive", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working",
        pendingNotification: "You have overlapping changes with PR #42",
      }),
    ]);
    vi.mocked(hasClaudeChild).mockReturnValue(true);

    poll();

    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5", "-l",
      "You have overlapping changes with PR #42",
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      pendingNotification: undefined,
    });
  });

  it("does not deliver pending notification when Claude is not alive", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "working",
        pendingNotification: "You have overlapping changes with PR #42",
      }),
    ]);
    vi.mocked(hasClaudeChild).mockReturnValue(false);

    poll();

    // Should not have cleared the notification
    const clearCalls = vi.mocked(updateWorkerFields).mock.calls.filter(
      c => c[2] && "pendingNotification" in (c[2] as Record<string, unknown>),
    );
    expect(clearCalls).toHaveLength(0);
  });
});

describe("poll — alerts", () => {
  it("adds alert on merge failure", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "APPROVE\nLooks good.", stderr: "",
    } as never);
    vi.mocked(mergePR).mockImplementation(() => { throw new Error("merge conflict"); });

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

  it("adds alert on rebase conflict", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(false);
    vi.mocked(hasClaudeChild).mockReturnValue(false);

    poll();

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "poller",
        message: expect.stringContaining("Rebase conflict"),
      }),
    );
  });

  it("adds alert after 3 repeated failures", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        prNumber: 42,
        failCount: 3,
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });

    poll();

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("failed 3 times"),
      }),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "open",
      failingSha: undefined,
    });
  });

  it("does not add repeated-failure alert below threshold", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        prNumber: 42,
        failCount: 2,
        lastSeenSha: "abc123",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });

    poll();

    expect(addAlert).not.toHaveBeenCalled();
  });

  it("resets failCount on successful merge", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42, failCount: 2 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "APPROVE\nLooks good.", stderr: "",
    } as never);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "merged", failCount: 0 }),
    );
  });

  it("increments failCount on review changes-requested", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "reviewing", prNumber: 42, failCount: 1 }),
    ]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "REQUEST_CHANGES\nNeeds tests.", stderr: "",
    } as never);
    // Guard uses isClaudeWorking (default false); notification needs Claude alive
    vi.mocked(hasClaudeChild).mockReturnValue(true);

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash",
      expect.objectContaining({ prState: "failing", failCount: 2 }),
    );
  });
});
