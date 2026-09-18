import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  DEFAULT_LEFT_COLUMN_PERCENT: 45,
  getBuildBranch: () => "main",
  getChecksSlotsOverride: () => undefined,
  getLeftColumnPercent: () => 40,
  getMaxConcurrentReviews: () => 0,
  setLeftColumnPercent: vi.fn(() => 40),
}));
vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({ activePaneId: "%9" })),
  writeDashState: vi.fn(),
  withStateLock: vi.fn(<T>(fn: () => T): T => fn()),
}));
vi.mock("../src/dashboard/create.js", () => ({ USAGE_PANE_HEIGHT: 5, presizeHiddenWindows: vi.fn() }));
vi.mock("../src/dashboard/header.js", () => ({ rebakePanesOnResize: vi.fn(() => true) }));
vi.mock("../src/dashboard/menu.js", () => ({ runMenu: vi.fn() }));
vi.mock("../src/dashboard/tmux.js", () => ({ tmuxDisplay: vi.fn() }));
vi.mock("../src/dashboard/runner.js", () => ({ resolveGardenRunner: () => "garden" }));
vi.mock("../src/dashboard/log.js", () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import { applyLeftColumnFromMenu } from "../src/dashboard/garden-menu.js";
import { setLeftColumnPercent } from "../src/config.js";
import { readDashState, writeDashState } from "../src/dashboard/state.js";
import { presizeHiddenWindows } from "../src/dashboard/create.js";
import { rebakePanesOnResize } from "../src/dashboard/header.js";
import { runMenu } from "../src/dashboard/menu.js";
import { tmuxDisplay } from "../src/dashboard/tmux.js";

beforeEach(() => vi.resetAllMocks());

describe("applyLeftColumnFromMenu", () => {
  it("resizes visible and parked panes before reopening the blocking menu", async () => {
    vi.mocked(runMenu).mockImplementation(() => {
      expect(rebakePanesOnResize).toHaveBeenCalledWith(expect.objectContaining(readDashState()), 5, 60);
      expect(presizeHiddenWindows).toHaveBeenCalledWith(expect.objectContaining(readDashState()));
    });
    await applyLeftColumnFromMenu("40");
    expect(setLeftColumnPercent).toHaveBeenCalledWith(40);
    expect(runMenu).toHaveBeenCalledOnce();
    expect(writeDashState).toHaveBeenCalledWith(expect.objectContaining({ appliedLeftPercent: 40 }));
    expect(vi.mocked(rebakePanesOnResize).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(presizeHiddenWindows).mock.invocationCallOrder[0]);
  });

  it("restores the selected split even when config is unchanged after a manual pane drag", async () => {
    vi.mocked(readDashState).mockReturnValue({ activePaneId: "%9", appliedLeftPercent: 40 } as never);
    await applyLeftColumnFromMenu("40");
    expect(rebakePanesOnResize).toHaveBeenCalledOnce();
    expect(writeDashState).toHaveBeenCalledOnce();
  });

  it("clears the override when unset is selected", async () => {
    await applyLeftColumnFromMenu("unset");
    expect(setLeftColumnPercent).toHaveBeenCalledWith(undefined);
    expect(presizeHiddenWindows).toHaveBeenCalledOnce();
  });

  it("reports invalid settings without resizing or reopening the menu", async () => {
    vi.mocked(setLeftColumnPercent).mockImplementationOnce(() => { throw new Error("invalid split"); });
    await applyLeftColumnFromMenu("10");
    expect(tmuxDisplay).toHaveBeenCalledWith("invalid split");
    expect(rebakePanesOnResize).not.toHaveBeenCalled();
    expect(runMenu).not.toHaveBeenCalled();
  });

  it("keeps the saved setting when the dashboard disappears", async () => {
    vi.mocked(readDashState).mockImplementationOnce(() => { throw new Error("dashboard gone"); });
    await applyLeftColumnFromMenu("40");
    expect(setLeftColumnPercent).toHaveBeenCalledWith(40);
    expect(runMenu).toHaveBeenCalledOnce();
  });
});
