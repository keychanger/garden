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
      gardenShellPaneId: null,
      gardenPaneType: null,
      gardenWindowName: null,
      activePaneId: null,
      activePaneType: null,
      activeWindowName: null,
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
      gardenShellPaneId: "%2",
      gardenPaneType: "console" as const,
      gardenWindowName: null,
      activePaneId: "%3",
      activePaneType: "worker" as const,
      activeWindowName: "_myproject-worker-bold-ash",
    };
    writeDashState(original);
    const loaded = readDashState();
    expect(loaded).toEqual(original);
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
    });
    expect(fs.existsSync(STATE_FILE)).toBe(true);
  });
});
