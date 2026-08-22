import { beforeEach, describe, expect, it, vi } from "vitest";

const { listSessionPanes, renameWindowById, readRegistry, addAlert } = vi.hoisted(() => ({
  listSessionPanes: vi.fn(),
  renameWindowById: vi.fn(),
  readRegistry: vi.fn(),
  addAlert: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  listSessionPanes,
  renameWindowById,
}));

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry,
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert,
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { healWorkerWindows } from "../src/dashboard/window-heal.js";
import { log } from "../src/dashboard/log.js";

beforeEach(() => {
  vi.clearAllMocks();
  readRegistry.mockReturnValue({
    workers: {
      garden: [{
        name: "firm-hale-ledge",
        sessionId: "s",
        task: "",
        worktreePath: "/worktrees/garden/firm-hale-ledge",
      }],
    },
  });
});

describe("healWorkerWindows", () => {
  it("renames a planned window by id and reports the successful heal", () => {
    listSessionPanes.mockReturnValue([{
      windowId: "@7",
      windowName: "_stray-7",
      paneId: "%7",
      width: 100,
      height: 40,
      panePath: "/worktrees/garden/firm-hale-ledge",
    }]);
    renameWindowById.mockReturnValue(true);

    expect(healWorkerWindows()).toBe(1);
    expect(renameWindowById).toHaveBeenCalledWith("@7", "_garden-worker-firm-hale-ledge");
    expect(log.info).toHaveBeenCalledWith(
      "watchdog",
      "healed misfiled worker window",
      expect.any(Object),
    );
  });

  it("does not count or report a rename that tmux rejected", () => {
    listSessionPanes.mockReturnValue([{
      windowId: "@7",
      windowName: "_stray-7",
      paneId: "%7",
      width: 100,
      height: 40,
      panePath: "/worktrees/garden/firm-hale-ledge",
    }]);
    renameWindowById.mockReturnValue(false);

    expect(healWorkerWindows()).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("alerts instead of renaming when two panes claim the same worker", () => {
    listSessionPanes.mockReturnValue([
      {
        windowId: "@1",
        windowName: "_garden-worker-firm-hale-ledge",
        paneId: "%1",
        width: 100,
        height: 40,
        panePath: "/worktrees/garden/firm-hale-ledge",
      },
      {
        windowId: "@7",
        windowName: "_stray-7",
        paneId: "%7",
        width: 100,
        height: 40,
        panePath: "/worktrees/garden/firm-hale-ledge",
      },
    ]);

    expect(healWorkerWindows()).toBe(0);
    expect(renameWindowById).not.toHaveBeenCalled();
    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      project: "garden",
      worker: "firm-hale-ledge",
      dedupKey: "window-heal-conflict:_garden-worker-firm-hale-ledge:@7",
    }));
    expect(log.warn).not.toHaveBeenCalled();
  });
});
