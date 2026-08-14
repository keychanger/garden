import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
}));

vi.mock("../src/dashboard/create.js", () => ({
  respawnStatusPane: vi.fn(),
  respawnUsagePane: vi.fn(),
  respawnHistoryPane: vi.fn(),
  respawnAlertsPane: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  writeAlertsRendered: vi.fn(),
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
}));

import { redraw } from "../src/commands/redraw.js";
import { dashboardExists } from "../src/session.js";
import { readDashState } from "../src/dashboard/state.js";
import {
  respawnStatusPane,
  respawnUsagePane,
  respawnHistoryPane,
  respawnAlertsPane,
} from "../src/dashboard/create.js";
import { refreshDashboard, writeAlertsRendered } from "../src/dashboard/header.js";
import { output } from "../src/output.js";

const state = { statusPaneId: "%2", usagePaneId: "%3", gardenPaneType: "growhouse" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readDashState).mockReturnValue(state as never);
});

describe("redraw", () => {
  it("does nothing when no dashboard session is running", async () => {
    vi.mocked(dashboardExists).mockReturnValue(false);
    await redraw([]);
    expect(respawnStatusPane).not.toHaveBeenCalled();
    expect(respawnUsagePane).not.toHaveBeenCalled();
    expect(respawnHistoryPane).not.toHaveBeenCalled();
    expect(respawnAlertsPane).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ redrawn: false }),
      expect.any(Function),
    );
  });

  it("re-bakes content, then respawns all four passive pane loops", async () => {
    vi.mocked(dashboardExists).mockReturnValue(true);
    await redraw([]);
    expect(refreshDashboard).toHaveBeenCalledWith({ state });
    expect(writeAlertsRendered).toHaveBeenCalledWith({ state });
    expect(respawnStatusPane).toHaveBeenCalledWith(state);
    expect(respawnUsagePane).toHaveBeenCalledWith(state);
    expect(respawnHistoryPane).toHaveBeenCalledWith(state);
    expect(respawnAlertsPane).toHaveBeenCalledWith(state);
    // Bake before respawn: the fresh loops read the pre-baked files on their
    // first iteration, so stale bakes would repaint stale content.
    const bakeOrder = vi.mocked(refreshDashboard).mock.invocationCallOrder[0];
    const respawnOrder = vi.mocked(respawnStatusPane).mock.invocationCallOrder[0];
    expect(bakeOrder).toBeLessThan(respawnOrder);
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ redrawn: true }),
      expect.any(Function),
    );
  });

  it("still respawns panes when the re-bake throws", async () => {
    vi.mocked(dashboardExists).mockReturnValue(true);
    vi.mocked(refreshDashboard).mockImplementation(() => { throw new Error("bake failed"); });
    await redraw([]);
    expect(respawnStatusPane).toHaveBeenCalledWith(state);
    expect(respawnUsagePane).toHaveBeenCalledWith(state);
  });
});
