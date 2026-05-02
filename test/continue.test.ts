import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
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
  shellEscape: vi.fn((s: string) => `'${s}'`),
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
  donePath, isDoneSet, clearDoneSentinel,
} from "../src/dashboard/continue.js";
import { readDashState } from "../src/dashboard/state.js";
import { findWorkerByName, updateWorkerFields } from "../src/dashboard/registry.js";
import { tmux, paneExists, windowExists, getFirstPaneId } from "../src/dashboard/tmux.js";
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
    expect(tmux).not.toHaveBeenCalled();
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

    expect(tmux).not.toHaveBeenCalled();
    // Flag must remain so a future resume can retry.
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("skips the send when the worker is already working (operator typed first) and clears the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      claudeStatus: "working", interruptedWhileWorking: true,
    });
    continueWorker("myproject", "bold-ash");

    expect(tmux).not.toHaveBeenCalled();
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

    expect(tmux).not.toHaveBeenCalled();
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

    const calls = vi.mocked(tmux).mock.calls;
    expect(calls[0]).toEqual([
      "send-keys", "-t", "%9", "-l",
      expect.stringContaining("[garden]"),
    ]);
    expect(calls[1]).toEqual(["send-keys", "-t", "%9", "Enter"]);
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

    const sendCall = vi.mocked(tmux).mock.calls[0];
    expect(sendCall).toContain("%41");
  });

  it("does not clear the flag when the send-keys call throws", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
    });
    vi.mocked(tmux).mockImplementation(() => { throw new Error("tmux died"); });

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
    expect(cmd).toContain("/usr/local/bin/garden dashboard _continue-worker");
    expect(cmd).toContain("'myproject'");
    expect(cmd).toContain("'bold-ash'");
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
    expect(cmd).toContain("'myproject'");
    expect(cmd).toContain("'bold-ash'");
  });

  it("swallows spawn errors", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() => dispatchDelayedAutoContinue("garden", "p", "w")).not.toThrow();
  });
});

describe("continueWorkerAfterMerge", () => {
  it("sends the merge-flavored prompt referencing the .done sentinel", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const sendKeysCall = vi.mocked(tmux).mock.calls[0];
    expect(sendKeysCall[0]).toBe("send-keys");
    expect(sendKeysCall[3]).toBe("-l");
    const message = sendKeysCall[4] as string;
    expect(message).toContain("[garden]");
    expect(message).toContain("merged");
    expect(message).toContain(".garden-done");
  });

  it("skips when the worker is already working", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", claudeStatus: "working",
    });
    continueWorkerAfterMerge("myproject", "bold-ash");
    expect(tmux).not.toHaveBeenCalled();
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
