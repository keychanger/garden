// The one lookup of a worker's pane, used by everything that pastes into it,
// reads it or sends it a key. Dashboard state only records which pane sits in
// the right slot; tmux says whether that pane is still there.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardState } from "../src/dashboard/state.js";

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
}));
vi.mock("../src/dashboard/tmux.js", () => ({
  getFirstPaneId: vi.fn(() => null),
  paneExists: vi.fn(() => false),
  windowExists: vi.fn(() => false),
}));

import { resolveWorkerPaneId } from "../src/dashboard/worker-pane.js";
import { readDashState } from "../src/dashboard/state.js";
import { getFirstPaneId, paneExists, windowExists } from "../src/dashboard/tmux.js";
import { DASHBOARD_SESSION } from "../src/session.js";

const WINDOW = "_wolf-worker-bold-ash";

function slot(activeWindowName: string | null, activePaneId: string | null): void {
  vi.mocked(readDashState).mockReturnValue({
    activeProject: "wolf",
    activePaneType: activeWindowName ? "worker" : null,
    activeWindowName,
    activePaneId,
  } as DashboardState);
}

// The worker's own window, holding `paneId` as its first pane.
function parked(paneId: string): void {
  vi.mocked(windowExists).mockImplementation(name => name === WINDOW);
  vi.mocked(getFirstPaneId).mockImplementation(target =>
    target === `${DASHBOARD_SESSION}:${WINDOW}` ? paneId : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paneExists).mockReturnValue(false);
  vi.mocked(windowExists).mockReturnValue(false);
  vi.mocked(getFirstPaneId).mockReturnValue(null);
});

describe("resolveWorkerPaneId", () => {
  it("returns the right slot's pane while the worker is in it and tmux still has the pane", () => {
    slot(WINDOW, "%7");
    vi.mocked(paneExists).mockImplementation(id => id === "%7");

    expect(resolveWorkerPaneId("wolf", "bold-ash")).toBe("%7");
    expect(windowExists).not.toHaveBeenCalled();
  });

  it("returns null rather than the recorded id once the slot's pane is gone", () => {
    slot(WINDOW, "%7");

    expect(resolveWorkerPaneId("wolf", "bold-ash")).toBeNull();
    expect(paneExists).toHaveBeenCalledWith("%7");
  });

  it("falls back to the worker's own window when the slot's recorded pane is gone", () => {
    slot(WINDOW, "%7");
    parked("%12");

    expect(resolveWorkerPaneId("wolf", "bold-ash")).toBe("%12");
  });

  it("finds a parked worker through its window, without probing another worker's slot pane", () => {
    slot("_wolf-worker-other", "%3");
    parked("%12");

    expect(resolveWorkerPaneId("wolf", "bold-ash")).toBe("%12");
    expect(paneExists).not.toHaveBeenCalled();
  });

  it("returns null when the worker is neither in the slot nor parked", () => {
    slot(null, null);

    expect(resolveWorkerPaneId("wolf", "bold-ash")).toBeNull();
    expect(getFirstPaneId).not.toHaveBeenCalled();
  });
});
