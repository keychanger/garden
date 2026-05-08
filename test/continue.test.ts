import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => "seed body"),
  },
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  pasteAndSubmit: vi.fn(),
  // Match real shellEscape: pass safe-token strings through unquoted, and
  // single-quote anything else. Tests must reflect actual behavior so
  // round-tripping a path with spaces produces the same shell.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`),
  getFirstPaneId: vi.fn(() => "%20"),
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => true),
}));

vi.mock("../src/dashboard/window-names.js", () => ({
  workerWindowName: (project: string, worker: string) => `_${project}-worker-${worker}`,
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  continueWorker, continueWorkerAfterMerge,
  dispatchDelayedContinue, dispatchDelayedAutoContinue,
  dispatchDelayedSeed, seedWorker,
  donePath, isDoneSet, clearDoneSentinel,
} from "../src/dashboard/continue.js";
import { readDashState } from "../src/dashboard/state.js";
import { findWorkerByName, updateWorkerFields } from "../src/dashboard/registry.js";
import { tmux, pasteAndSubmit, paneExists, windowExists, getFirstPaneId } from "../src/dashboard/tmux.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { DashboardState } from "../src/dashboard/state.js";

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "myproject",
    statusPaneId: null,
    gardenShellPaneId: null,
    gardenPaneType: null,
    gardenWindowName: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paneExists).mockReturnValue(true);
  vi.mocked(windowExists).mockReturnValue(true);
  vi.mocked(getFirstPaneId).mockReturnValue("%30");
  vi.mocked(readDashState).mockReturnValue(makeState());
});

describe("continueWorker", () => {
  it("is a no-op when the worker entry is missing", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);
    continueWorker("myproject", "ghost");
    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("skips the send when no pane can be located and does not clear the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      claudeStatus: "idle", interruptedWhileWorking: true,
    });
    vi.mocked(windowExists).mockReturnValue(false);
    // activePaneId path also fails
    vi.mocked(readDashState).mockReturnValue(makeState({ activePaneId: null }));

    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    // Flag must remain so a future resume can retry.
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("skips the send when the worker is already working (operator typed first) and clears the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      claudeStatus: "working", interruptedWhileWorking: true,
    });
    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "bold-ash", { interruptedWhileWorking: undefined },
    );
  });

  it("skips the send when the worker is asking and clears the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      claudeStatus: "asking", interruptedWhileWorking: true,
    });
    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "bold-ash", { interruptedWhileWorking: undefined },
    );
  });

  it("sends the literal continue prompt followed by Enter when worker is idle, then clears the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      claudeStatus: "idle", interruptedWhileWorking: true,
    });
    // Prefer activePaneId path
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledWith(
      "%9", expect.stringContaining("[garden]"),
    );
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "bold-ash", { interruptedWhileWorking: undefined },
    );
  });

  it("falls back to the hidden window pane id when the worker is parked", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
    });
    // Active pane points elsewhere; window-resolution path fires.
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-other",
      activePaneId: "%99",
    }));
    vi.mocked(getFirstPaneId).mockReturnValue("%41");

    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledWith("%41", expect.any(String));
  });

  it("does not clear the flag when the send-keys call throws", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
    });
    vi.mocked(pasteAndSubmit).mockImplementation(() => { throw new Error("tmux died"); });

    expect(() => continueWorker("myproject", "bold-ash")).not.toThrow();
    // Flag stays so a later attempt can retry.
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});

describe("dispatchDelayedContinue", () => {
  it("spawns a detached sh -c that delays and invokes the _continue-worker subcommand", () => {
    dispatchDelayedContinue("/usr/local/bin/garden", "myproject", "bold-ash");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [shCmd, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(shCmd).toBe("sh");
    expect(args).toEqual(["-c", expect.any(String)]);
    const cmd = (args as string[])[1];
    expect(cmd).toMatch(/^sleep 3 && /);
    // Safe-token strings (alphanumeric + ./_:-) are passed through unquoted
    // by shellEscape. Project/worker names that contain other characters
    // would be single-quoted; the assertions below stay alphanumeric so they
    // verify the unquoted-but-shell-safe path.
    expect(cmd).toContain("/usr/local/bin/garden dashboard _continue-worker");
    expect(cmd).toContain(" myproject ");
    expect(cmd).toContain(" bold-ash ");
    expect(opts).toEqual(expect.objectContaining({ detached: true, stdio: "ignore" }));
  });

  it("swallows spawn errors so a failed dispatch never crashes the caller", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() => dispatchDelayedContinue("garden", "p", "w")).not.toThrow();
  });
});

describe("dispatchDelayedAutoContinue", () => {
  it("spawns a detached sh -c that invokes _continue-worker-after-merge with a longer delay", () => {
    dispatchDelayedAutoContinue("/usr/local/bin/garden", "myproject", "bold-ash");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(spawn).mock.calls[0];
    const cmd = (args as string[])[1];
    expect(cmd).toMatch(/^sleep 5 && /);
    expect(cmd).toContain("/usr/local/bin/garden dashboard _continue-worker-after-merge");
    expect(cmd).toContain(" myproject ");
    expect(cmd).toContain(" bold-ash ");
  });

  it("swallows spawn errors", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() => dispatchDelayedAutoContinue("garden", "p", "w")).not.toThrow();
  });
});

describe("continueWorkerAfterMerge", () => {
  it("sends the merge-flavored prompt referencing the .garden-done sentinel", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("[garden]");
    expect(message).toContain("merged");
    expect(message).toContain(".garden-done");
  });

  it("skips when the worker is already working", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "working",
    });
    continueWorkerAfterMerge("myproject", "bold-ash");
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("prepends a stale-files preamble when the reviewer modified files", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
      branchName: "bold-ash",
      pendingContinueChangedFiles: ["src/foo.ts", "src/bar.ts"],
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("During review");
    expect(message).toContain("src/foo.ts");
    expect(message).toContain("src/bar.ts");
    expect(message).toContain("re-read");
    expect(message).toContain("merged");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      pendingContinueChangedFiles: undefined,
      pendingContinueSyncFailed: undefined,
    });
  });

  it("truncates the file list past 20 entries", () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
      branchName: "bold-ash",
      pendingContinueChangedFiles: files,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("src/file0.ts");
    expect(message).toContain("src/file19.ts");
    expect(message).not.toContain("src/file20.ts");
    expect(message).toContain("(and 5 more)");
  });

  it("appends a manual-sync nudge targeting the base branch when the post-merge sync failed", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
      branchName: "bold-ash",
      baseBranch: "main",
      pendingContinueSyncFailed: true,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("could not auto-sync");
    // The worker branch is deleted from origin post-merge, so the hint must
    // target origin/<base>, not origin/<branch>.
    expect(message).toContain("git fetch origin main && git reset --hard origin/main");
    expect(message).not.toContain("origin/bold-ash");
  });

  it("uses the bare base prompt when no transient fields are set", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).not.toContain("During review");
    expect(message).not.toContain("could not auto-sync");
    expect(message).toContain("merged");
    expect(message).toContain(".garden-done");
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});

describe("done-sentinel helpers", () => {
  const wt = "/Users/x/.garden/worktrees/myproject/bold-ash";

  it("donePath joins the worktree root with .garden-done", () => {
    expect(donePath(wt)).toBe(`${wt}/.garden-done`);
  });

  it("isDoneSet reflects fs.existsSync at the donePath", () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);
    expect(isDoneSet(wt)).toBe(true);
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    expect(isDoneSet(wt)).toBe(false);
  });

  it("isDoneSet returns false for legacy entries with no worktreePath", () => {
    expect(isDoneSet(undefined)).toBe(false);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it("clearDoneSentinel unlinks the donePath and tolerates ENOENT", () => {
    clearDoneSentinel(wt);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${wt}/.garden-done`);

    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(() => clearDoneSentinel(wt)).not.toThrow();
  });

  it("clearDoneSentinel is a no-op for legacy entries with no worktreePath", () => {
    clearDoneSentinel(undefined);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("dispatchDelayedSeed", () => {
  it("spawns a detached sh -c that invokes _seed-worker with a longer delay than auto-continue", () => {
    dispatchDelayedSeed("/usr/local/bin/garden", "myproject", "bold-ash", "/tmp/seed.txt");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(spawn).mock.calls[0];
    const cmd = (args as string[])[1];
    // Bootstrap (git fetch + worktree add + claude TUI init) takes longer than
    // a normal end-of-turn — 6s so keys don't land in a still-initializing TUI.
    expect(cmd).toMatch(/^sleep 6 && /);
    expect(cmd).toContain("/usr/local/bin/garden dashboard _seed-worker");
    expect(cmd).toContain(" myproject ");
    expect(cmd).toContain(" bold-ash ");
    expect(cmd).toContain(" /tmp/seed.txt ");
  });

  it("swallows spawn errors so a failed dispatch never crashes the caller", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() => dispatchDelayedSeed("garden", "p", "w", "/tmp/x.txt")).not.toThrow();
  });
});

describe("seedWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.readFileSync).mockReturnValue("[handoff from src/worker]\n\nbriefing body");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the briefing, sends it once the worker leaves loading, and unlinks the file", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "ready",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");

    expect(fs.readFileSync).toHaveBeenCalledWith("/tmp/seed.txt", "utf8");
    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("[handoff from src/worker]");
    expect(message).toContain("briefing body");
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("polls while the worker is still loading and sends as soon as it transitions", () => {
    let status: "loading" | "ready" = "loading";
    vi.mocked(findWorkerByName).mockImplementation(() => ({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: status,
    }));
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");
    // First poll sees "loading" — no send yet.
    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();

    // Worker finishes bootstrap; next 2s tick sends the briefing.
    status = "ready";
    vi.advanceTimersByTime(2000);
    expect(vi.mocked(pasteAndSubmit)).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("times out after 90s if the worker never leaves loading, sends anyway, and unlinks", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "loading",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");
    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(90_000);
    // After deadline elapses, the next poll sends regardless of status so the
    // briefing isn't silently lost on a stuck worker.
    expect(vi.mocked(pasteAndSubmit)).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("aborts and unlinks the file when the worker has already been killed", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");

    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("aborts silently when the seed file can't be read (already cleaned up)", () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw new Error("ENOENT"); });

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");

    expect(vi.mocked(findWorkerByName)).not.toHaveBeenCalled();
    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();
    // No re-unlink — there's nothing to clean up if the file was already gone.
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
