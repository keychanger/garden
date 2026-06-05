import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

async function importState() {
  return await import("../src/dashboard/state.js");
}

describe("readDashState", () => {
  it("returns default state when no file exists", async () => {
    const { readDashState } = await importState();
    const state = readDashState();
    expect(state).toEqual({
      activeProject: null,
      activePlot: null,
      statusPaneId: null,
      usagePaneId: null,
      gardenShellPaneId: null,
      gardenPaneType: null,
      gardenWindowName: null,
      activePaneId: null,
      activePaneType: null,
      activeWindowName: null,
      lastActiveWorker: {},
      lastActiveProjectByPlot: {},
    });
  });

  it("returns default state on corrupted JSON", async () => {
    const { readDashState, STATE_FILE } = await importState();
    fs.writeFileSync(STATE_FILE, "not json{{{");
    const state = readDashState();
    expect(state.activeProject).toBeNull();
  });

  it("returns default state when a top-level field has the wrong primitive type", async () => {
    const { readDashState, STATE_FILE } = await importState();
    // statusPaneId must be string|null. A numeric value indicates corruption
    // (or a forward-incompatible dashboard build sharing the file). Falling
    // back to defaults is safer than feeding a number into setPaneVar.
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      activeProject: null, activePlot: null,
      statusPaneId: 42, usagePaneId: null,
      gardenShellPaneId: null, gardenPaneType: "growhouse",
      gardenWindowName: null, activePaneId: null,
      activePaneType: null, activeWindowName: null,
      lastActiveWorker: {}, lastActiveProjectByPlot: {},
    }));
    expect(readDashState().statusPaneId).toBeNull();
  });

  it("returns default state when a Record-typed field is an array", async () => {
    const { readDashState, STATE_FILE } = await importState();
    // lastActiveWorker must be Record<string, string>; an array would
    // pass `typeof === "object"` but break the project-name lookup.
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      activeProject: null, activePlot: null,
      statusPaneId: null, usagePaneId: null,
      gardenShellPaneId: null, gardenPaneType: "growhouse",
      gardenWindowName: null, activePaneId: null,
      activePaneType: null, activeWindowName: null,
      lastActiveWorker: ["bogus"],
      lastActiveProjectByPlot: {},
    }));
    expect(readDashState().lastActiveWorker).toEqual({});
  });
});

describe("writeDashState / readDashState", () => {
  it("round-trips state", async () => {
    const { readDashState, writeDashState } = await importState();
    const original = {
      activeProject: "myproject",
      activePlot: null,
      statusPaneId: "%1",
      usagePaneId: null,
      gardenShellPaneId: "%2",
      gardenPaneType: "growhouse" as const,
      gardenWindowName: null,
      activePaneId: "%3",
      activePaneType: "worker" as const,
      activeWindowName: "_myproject-worker-bold-ash",
      lastActiveWorker: {},
      lastActiveProjectByPlot: {},
    };
    writeDashState(original);
    const loaded = readDashState();
    expect(loaded).toEqual(original);
  });

  it("migrates old garden view to growhouse", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const oldState = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "garden",
      gardenWindowName: "_garden-garden",
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(oldState));
    const loaded = readDashState();
    expect(loaded.gardenPaneType).toBe("growhouse");
    expect(loaded.gardenWindowName).toBe("_garden-growhouse");
  });

  it("migrates console to growhouse", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const oldState = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "console",
      gardenWindowName: "_garden-console",
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(oldState));
    const loaded = readDashState();
    expect(loaded.gardenPaneType).toBe("growhouse");
    expect(loaded.gardenWindowName).toBe("_garden-growhouse");
  });

  it("migrates conversation view to history", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const oldState = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "conversation",
      gardenWindowName: "_garden-conversation",
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(oldState));
    const loaded = readDashState();
    expect(loaded.gardenPaneType).toBe("history");
    expect(loaded.gardenWindowName).toBe("_garden-history");
  });

  it("migrates pad view to diary", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const oldState = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "pad",
      gardenWindowName: "_garden-pad",
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(oldState));
    const loaded = readDashState();
    expect(loaded.gardenPaneType).toBe("diary");
    expect(loaded.gardenWindowName).toBe("_garden-diary");
  });

  it("backfills lastActiveWorker for old state files", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const oldState = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(oldState));
    const loaded = readDashState();
    expect(loaded.lastActiveWorker).toEqual({});
    expect(loaded.lastActiveProjectByPlot).toEqual({});
  });

  it("recovers root-with-null-window to growhouse", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const oldState = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "root",
      gardenWindowName: null,
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(oldState));
    const loaded = readDashState();
    expect(loaded.gardenPaneType).toBe("growhouse");
  });

  it("creates directory if missing", async () => {
    const { writeDashState, STATE_FILE } = await importState();
    const dir = path.dirname(STATE_FILE);
    fs.rmSync(dir, { recursive: true, force: true });
    writeDashState({
      activeProject: null,
      statusPaneId: null,
      gardenShellPaneId: null,
      gardenPaneType: null,
      gardenWindowName: null,
      activePaneId: null,
      activePaneType: null,
      activeWindowName: null,
      lastActiveWorker: {},
      lastActiveProjectByPlot: {},
    });
    expect(fs.existsSync(STATE_FILE)).toBe(true);
  });
});

describe("withStateLock", () => {
  it("runs fn and cleans up lock file", async () => {
    const { withStateLock, STATE_FILE } = await importState();
    const lockFile = STATE_FILE + ".lock";
    let sawLock = false;
    withStateLock(() => {
      sawLock = fs.existsSync(lockFile);
    });
    expect(sawLock).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("throws when lock is held by a live process", async () => {
    const { withStateLock, STATE_FILE } = await importState();
    const lockFile = STATE_FILE + ".lock";
    fs.writeFileSync(lockFile, String(process.pid));
    try {
      expect(() => withStateLock(() => {})).toThrow(
        /Could not acquire state lock after \d+ms/
      );
    } finally {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }, 5000);
});

describe("readDashState mtime cache", () => {
  it("returns a fresh clone each call so callers can mutate without polluting the cache", async () => {
    const { readDashState, STATE_FILE } = await importState();
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      activeProject: "garden", activePlot: null,
      statusPaneId: null, usagePaneId: null,
      gardenShellPaneId: null, gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
      activePaneId: null, activePaneType: null, activeWindowName: null,
      lastActiveWorker: {}, lastActiveProjectByPlot: {},
    }));

    const first = readDashState();
    first.activeProject = "mutated";
    first.lastActiveWorker.someProj = "fake-worker";

    const second = readDashState();
    // The mutation on `first` must not leak into `second`. The read-modify-
    // writeDashState pattern under withStateLock relies on this.
    expect(second.activeProject).toBe("garden");
    expect(second.lastActiveWorker).toEqual({});
  });

  it("invalidates after writeDashState", async () => {
    const { readDashState, writeDashState, STATE_FILE } = await importState();
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      activeProject: "garden", activePlot: null,
      statusPaneId: null, usagePaneId: null,
      gardenShellPaneId: null, gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
      activePaneId: null, activePaneType: null, activeWindowName: null,
      lastActiveWorker: {}, lastActiveProjectByPlot: {},
    }));

    expect(readDashState().activeProject).toBe("garden");

    writeDashState({
      activeProject: "second-project", activePlot: null,
      statusPaneId: null, usagePaneId: null,
      gardenShellPaneId: null, gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
      activePaneId: null, activePaneType: null, activeWindowName: null,
      lastActiveWorker: {}, lastActiveProjectByPlot: {},
    });

    expect(readDashState().activeProject).toBe("second-project");
  });
});
