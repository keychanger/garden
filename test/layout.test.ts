import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  getFirstPaneId: vi.fn(),
  windowExists: vi.fn(() => false),
  killWindowSafe: vi.fn(),
  paneExists: vi.fn(() => true),
}));

import { parkToHidden, restoreFromHidden, swapToHidden } from "../src/dashboard/layout.js";
import { tmux, getFirstPaneId, windowExists, killWindowSafe, paneExists } from "../src/dashboard/tmux.js";
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
    vi.mocked(getFirstPaneId).mockReturnValue("%10");
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);

    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard", "-n", "_garden-worker-bold-ash"
    );
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%10"
    );
  });

  it("kills existing window with same name before creating", () => {
    vi.mocked(windowExists).mockReturnValue(true);
    vi.mocked(getFirstPaneId).mockReturnValue("%10");
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
    vi.mocked(getFirstPaneId).mockReturnValue("%10");
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
    let callOrder = 0;
    vi.mocked(getFirstPaneId).mockImplementation(() => {
      callOrder++;
      return callOrder === 1 ? "%10" : "%20";
    });

    const state = makeState();
    swapToHidden("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    const tmuxCalls = vi.mocked(tmux).mock.calls;
    const newWindowIdx = tmuxCalls.findIndex(c => c[0] === "new-window");
    const swapCalls = tmuxCalls.filter(c => c[0] === "swap-pane");
    expect(swapCalls.length).toBe(2);
    expect(newWindowIdx).toBeLessThan(tmuxCalls.indexOf(swapCalls[1]));
  });
});
