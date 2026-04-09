import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxNewWindow: vi.fn(),
  getFirstPaneId: vi.fn(),
  windowExists: vi.fn(() => false),
  killWindowSafe: vi.fn(),
  renameWindow: vi.fn(),
  paneExists: vi.fn(() => true),
  getPaneSize: vi.fn(() => ({ width: 129, height: 58 })),
  resizeWindow: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { parkToHidden, restoreFromHidden, swapToHidden, swapDirect } from "../src/dashboard/layout.js";
import { tmux, tmuxNewWindow, getFirstPaneId, windowExists, killWindowSafe, renameWindow, paneExists } from "../src/dashboard/tmux.js";
import type { DashboardState } from "../src/dashboard/state.js";

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: "_garden-worker-bold-ash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paneExists).mockReturnValue(true);
  vi.mocked(windowExists).mockReturnValue(false);
});

describe("parkToHidden", () => {
  it("creates hidden window and swaps pane into it", () => {
    vi.mocked(tmuxNewWindow).mockReturnValue("%10");
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);

    expect(vi.mocked(tmuxNewWindow)).toHaveBeenCalledWith(
      "-d", "-t", "garden-dashboard", "-n", "_garden-worker-bold-ash"
    );
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%10"
    );
  });

  it("always kills existing window before creating", () => {
    vi.mocked(tmuxNewWindow).mockReturnValue("%10");
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);

    expect(vi.mocked(killWindowSafe)).toHaveBeenCalledWith("_garden-worker-bold-ash");
  });

  it("returns null when activePaneId is missing", () => {
    const state = makeState({ activePaneId: null });
    const result = parkToHidden("_garden-worker-bold-ash", state);
    expect(result).toBeNull();
  });

  it("returns null when active pane does not exist", () => {
    vi.mocked(paneExists).mockReturnValue(false);
    const state = makeState();
    const result = parkToHidden("_garden-worker-bold-ash", state);
    expect(result).toBeNull();
  });

  it("clears activePaneType and activeWindowName on state", () => {
    vi.mocked(tmuxNewWindow).mockReturnValue("%10");
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);
    expect(state.activePaneType).toBeNull();
    expect(state.activeWindowName).toBeNull();
    expect(state.activePaneId).toBe("%10");
  });
});

describe("restoreFromHidden", () => {
  it("swaps target pane into right slot and kills hidden window", () => {
    vi.mocked(getFirstPaneId).mockReturnValue("%20");
    const state = makeState();
    restoreFromHidden("_garden-worker-calm-bay", state);

    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%20"
    );
    expect(vi.mocked(killWindowSafe)).toHaveBeenCalledWith("_garden-worker-calm-bay");
    expect(state.activePaneId).toBe("%20");
  });

  it("is a no-op when target window has no pane", () => {
    vi.mocked(getFirstPaneId).mockReturnValue(null);
    const state = makeState();
    restoreFromHidden("_garden-worker-missing", state);

    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
    expect(state.activePaneId).toBe("%2");
  });

  it("is a no-op when activePaneId is null", () => {
    vi.mocked(getFirstPaneId).mockReturnValue("%20");
    const state = makeState({ activePaneId: null });
    restoreFromHidden("_garden-worker-calm-bay", state);

    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });
});

describe("swapToHidden", () => {
  it("parks then restores in sequence", () => {
    vi.mocked(tmuxNewWindow).mockReturnValue("%10");
    vi.mocked(getFirstPaneId).mockReturnValue("%20");

    const state = makeState();
    swapToHidden("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(vi.mocked(tmuxNewWindow)).toHaveBeenCalled();
    const swapCalls = vi.mocked(tmux).mock.calls.filter(c => c[0] === "swap-pane");
    expect(swapCalls.length).toBe(2);
  });
});

describe("swapDirect", () => {
  it("swaps panes and renames window in one step", () => {
    vi.mocked(getFirstPaneId).mockReturnValue("%20");
    const state = makeState();
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(result).toBe(true);
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%20"
    );
    expect(vi.mocked(renameWindow)).toHaveBeenCalledWith(
      "_garden-worker-calm-bay", "_garden-worker-bold-ash"
    );
    expect(state.activePaneId).toBe("%20");
  });

  it("does not create or kill any windows", () => {
    vi.mocked(getFirstPaneId).mockReturnValue("%20");
    const state = makeState();
    swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(vi.mocked(tmuxNewWindow)).not.toHaveBeenCalled();
    expect(vi.mocked(killWindowSafe)).not.toHaveBeenCalled();
  });

  it("returns false when active pane is missing", () => {
    const state = makeState({ activePaneId: null });
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);
    expect(result).toBe(false);
    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });

  it("returns false when target window is missing", () => {
    vi.mocked(getFirstPaneId).mockReturnValue(null);
    const state = makeState();
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);
    expect(result).toBe(false);
    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });
});
