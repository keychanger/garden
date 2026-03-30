import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync, execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => ""),
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

vi.mock("../src/dashboard/git.js", () => ({
  getBranchPR: vi.fn(() => null),
  getPRInfo: vi.fn(() => ({ state: "OPEN", headSha: "abc123" })),
  rebaseBranch: vi.fn(() => true),
  abortRebase: vi.fn(),
  forcePushBranch: vi.fn(),
  mergePR: vi.fn(),
  commentOnPR: vi.fn(),
  fastForwardMain: vi.fn(),
}));

import { poll } from "../src/dashboard/poller.js";
import { tryGetProject } from "../src/config.js";
import { updateWorkerFields, getWorkers } from "../src/dashboard/registry.js";
import {
  getBranchPR, getPRInfo, rebaseBranch, abortRebase,
  forcePushBranch, mergePR, commentOnPR,
} from "../src/dashboard/git.js";
import { refreshDashboard } from "../src/dashboard/header.js";
import { tmux } from "../src/dashboard/tmux.js";
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
  vi.clearAllMocks();
  registryMock._clear();
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: undefined } as ReturnType<typeof tryGetProject>);
  vi.mocked(rebaseBranch).mockReturnValue(true);
  vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "abc123" });
  vi.mocked(getBranchPR).mockReturnValue(null);
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
  it("rebases, force-pushes, and merges", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(rebaseBranch).mockReturnValue(true);

    poll();

    expect(rebaseBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(forcePushBranch).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash");
    expect(mergePR).toHaveBeenCalledWith("/repo/myproject", 42);
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "merged",
      mergedAt: expect.any(String),
    });
  });
});

describe("poll — open state with checks", () => {
  it("transitions to failing when checks fail", () => {
    registryMock._setEntries("myproject", [
      makeWorker({ prState: "open", prNumber: 42 }),
    ]);
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject",
      checks: "npm test",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("tests failed"), { stderr: Buffer.from("FAIL src/foo.test.ts") });
    });

    poll();

    expect(execSync).toHaveBeenCalledWith(
      "npm test",
      expect.objectContaining({ cwd: "/tmp/wt/myproject/bold-ash" }),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      prState: "failing",
      lastSeenSha: "abc123",
      lastShaChangeAt: expect.any(String),
    });
    expect(rebaseBranch).not.toHaveBeenCalled();
  });
});

describe("poll — failing state", () => {
  it("resets debounce when SHA changes", () => {
    registryMock._setEntries("myproject", [
      makeWorker({
        prState: "failing",
        prNumber: 42,
        lastSeenSha: "old-sha",
        lastShaChangeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    vi.mocked(getPRInfo).mockReturnValue({ state: "OPEN", headSha: "new-sha" });

    poll();

    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      lastSeenSha: "new-sha",
      lastShaChangeAt: expect.any(String),
    });
  });

  it("transitions back to open after debounce with same SHA", () => {
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
