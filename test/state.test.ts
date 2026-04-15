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
      statusPaneId: null,
      usagePaneId: null,
      gardenShellPaneId: null,
      gardenPaneType: null,
      gardenWindowName: null,
      activePaneId: null,
      activePaneType: null,
      activeWindowName: null,
      lastActiveWorker: {},
    });
  });

  it("returns default state on corrupted JSON", async () => {
    const { readDashState, STATE_FILE } = await importState();
    fs.writeFileSync(STATE_FILE, "not json{{{");
    const state = readDashState();
    expect(state.activeProject).toBeNull();
  });
});

describe("writeDashState / readDashState", () => {
  it("round-trips state", async () => {
    const { readDashState, writeDashState } = await importState();
    const original = {
      activeProject: "myproject",
      statusPaneId: "%1",
      usagePaneId: null,
      gardenShellPaneId: "%2",
      gardenPaneType: "garden" as const,
      gardenWindowName: null,
      activePaneId: "%3",
      activePaneType: "worker" as const,
      activeWindowName: "_myproject-worker-bold-ash",
      lastActiveWorker: {},
    };
    writeDashState(original);
    const loaded = readDashState();
    expect(loaded).toEqual(original);
  });

  it("migrates old console to garden", async () => {
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
    expect(loaded.gardenPaneType).toBe("garden");
    expect(loaded.gardenWindowName).toBe("_garden-garden");
  });

  it("migrates old shell to root", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const state = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "shell",
      gardenWindowName: "_garden-shell",
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    const loaded = readDashState();
    expect(loaded.gardenPaneType).toBe("root");
    expect(loaded.gardenWindowName).toBe("_garden-root");
  });

  it("backfills lastActiveWorker for old state files", async () => {
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
    expect(loaded.lastActiveWorker).toEqual({});
  });

  it("migrates old root-with-null-window to garden", async () => {
    const { readDashState, STATE_FILE } = await importState();
    const oldState = {
      activeProject: "myproject",
      statusPaneId: "%1",
      gardenShellPaneId: "%2",
      gardenPaneType: "shell",
      gardenWindowName: null,
      activePaneId: "%3",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-bold-ash",
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(oldState));
    const loaded = readDashState();
    expect(loaded.gardenPaneType).toBe("garden");
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
        "Could not acquire state lock after 500ms"
      );
    } finally {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }, 2000);
});
