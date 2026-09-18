// The column-split reconciler: the drift check that gets a changed
// `layout.leftPercent` onto the panes without an operator event. Every other
// site that sizes the right slot fires on create / attach / repair / resize, so
// a setting changed while a session stays attached — including a new build
// changing the default — previously had no path to the panes at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  activePaneId: "%9" as string | null,
  appliedLeftPercent: null as number | null,
};
let configuredLeft = 45;
let onLock: (() => void) | undefined;
let lockHeld = false;

vi.mock("../src/config.js", () => ({
  getLeftColumnPercent: vi.fn(() => configuredLeft),
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({ ...state })),
  writeDashState: vi.fn((s: typeof state) => { state.appliedLeftPercent = s.appliedLeftPercent; }),
  withStateLock: vi.fn(<T>(fn: () => T): T => {
    onLock?.();
    lockHeld = true;
    try { return fn(); } finally { lockHeld = false; }
  }),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const rebakePanesOnResize = vi.fn(() => true);
const presizeHiddenWindows = vi.fn();

vi.mock("../src/dashboard/header.js", () => ({ rebakePanesOnResize }));
vi.mock("../src/dashboard/create.js", () => ({
  USAGE_PANE_HEIGHT: 5,
  presizeHiddenWindows,
}));

const { reconcileColumnSplit } =
  await import("../src/dashboard/column-split.js");

beforeEach(() => {
  vi.clearAllMocks();
  state.activePaneId = "%9";
  state.appliedLeftPercent = null;
  configuredLeft = 45;
  onLock = undefined;
  lockHeld = false;
  rebakePanesOnResize.mockReset().mockReturnValue(true);
});

describe("reconcileColumnSplit", () => {
  it("applies the configured split to a dashboard that has applied none", async () => {
    // The shipped case: a session created before the split was configurable.
    // Its panes are an even split and no event will ever correct them.
    const result = await reconcileColumnSplit();
    expect(result).toEqual({ applied: true, leftPercent: 45 });
    expect(rebakePanesOnResize).toHaveBeenCalledOnce();
    expect(presizeHiddenWindows).toHaveBeenCalledOnce();
    expect(state.appliedLeftPercent).toBe(45);
  });

  it("is a no-op once the panes already show the configured split", async () => {
    state.appliedLeftPercent = 45;
    const result = await reconcileColumnSplit();
    expect(result.applied).toBe(false);
    expect(rebakePanesOnResize).not.toHaveBeenCalled();
  });

  it("re-applies when the configured value changes under a live session", async () => {
    state.appliedLeftPercent = 45;
    configuredLeft = 40;
    const result = await reconcileColumnSplit();
    expect(result).toEqual({ applied: true, leftPercent: 40 });
    expect(state.appliedLeftPercent).toBe(40);
  });

  it("does nothing when there is no right slot to size", async () => {
    // No live dashboard (or a slot mid-repair): applying would throw, and
    // marking it applied would make the next tick skip the real repair.
    state.activePaneId = null;
    const result = await reconcileColumnSplit();
    expect(result.applied).toBe(false);
    expect(rebakePanesOnResize).not.toHaveBeenCalled();
    expect(state.appliedLeftPercent).toBeNull();
  });

  it("retries after the resize helper reports a failed tmux resize", async () => {
    rebakePanesOnResize.mockReturnValueOnce(false);
    expect((await reconcileColumnSplit()).applied).toBe(false);
    expect(state.appliedLeftPercent).toBeNull();
    expect(presizeHiddenWindows).not.toHaveBeenCalled();
    expect((await reconcileColumnSplit()).applied).toBe(true);
    expect(state.appliedLeftPercent).toBe(45);
  });

  it("uses the current pane and config under the navigation lock", async () => {
    onLock = () => {
      state.activePaneId = "%10";
      configuredLeft = 40;
    };
    rebakePanesOnResize.mockImplementationOnce(() => {
      expect(lockHeld).toBe(true);
      return true;
    });
    expect(await reconcileColumnSplit()).toEqual({ applied: true, leftPercent: 40 });
    expect(rebakePanesOnResize).toHaveBeenCalledWith(
      expect.objectContaining({ activePaneId: "%10" }), 5, 60,
    );
    expect(state.appliedLeftPercent).toBe(40);
  });

  it("skips work another caller completed before the lock was acquired", async () => {
    onLock = () => { state.appliedLeftPercent = configuredLeft; };
    expect((await reconcileColumnSplit()).applied).toBe(false);
    expect(rebakePanesOnResize).not.toHaveBeenCalled();
  });

  it("skips a right slot removed before the lock was acquired", async () => {
    onLock = () => { state.activePaneId = null; };
    expect((await reconcileColumnSplit()).applied).toBe(false);
    expect(rebakePanesOnResize).not.toHaveBeenCalled();
    expect(state.appliedLeftPercent).toBeNull();
  });

  it("leaves the marker unwritten when the pane work throws, so the next tick retries", async () => {
    rebakePanesOnResize.mockImplementationOnce(() => { throw new Error("pane gone"); });
    await expect(reconcileColumnSplit()).rejects.toThrow("pane gone");
    expect(state.appliedLeftPercent).toBeNull();
  });
});
