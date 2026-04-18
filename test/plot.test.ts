import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureConsoleLog } from "./helpers.js";

let tmpHome: string;
let originalHome: string | undefined;

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));
vi.mock("../src/session.js", () => ({
  dashboardExists: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-plot-cmd-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function setup() {
  const config = await import("../src/config.js");
  fs.mkdirSync(config.GARDEN_DIR, { recursive: true });
  fs.mkdirSync(config.SESSIONS_DIR, { recursive: true });
  return config;
}

async function writeActivePlot(plot: string | null): Promise<void> {
  const state = await import("../src/dashboard/state.js");
  state.writeDashState({
    activeProject: null,
    activePlot: plot,
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
}

describe("garden plot rename", () => {
  it("migrates the active-plot pointer when renaming the active plot", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { oldname: { projects: [] } },
    });
    await writeActivePlot("oldname");

    const { plot } = await import("../src/commands/plot.js");
    await captureConsoleLog(() => plot(["rename", "oldname", "newname"]));

    const state = await import("../src/dashboard/state.js");
    expect(state.readDashState().activePlot).toBe("newname");
  });

  it("leaves the active-plot pointer alone when renaming a non-active plot", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { active: { projects: [] }, other: { projects: [] } },
    });
    await writeActivePlot("active");

    const { plot } = await import("../src/commands/plot.js");
    await captureConsoleLog(() => plot(["rename", "other", "renamed"]));

    const state = await import("../src/dashboard/state.js");
    expect(state.readDashState().activePlot).toBe("active");
  });
});

describe("garden plot create", () => {
  it("auto-activates the created plot when nothing is active", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: {} });
    await writeActivePlot(null);

    const { plot } = await import("../src/commands/plot.js");
    await captureConsoleLog(() => plot(["create", "lab"]));

    const state = await import("../src/dashboard/state.js");
    expect(state.readDashState().activePlot).toBe("lab");
  });

  it("does not auto-activate when another plot is already active", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { existing: { projects: [] } },
    });
    await writeActivePlot("existing");

    const { plot } = await import("../src/commands/plot.js");
    await captureConsoleLog(() => plot(["create", "new"]));

    const state = await import("../src/dashboard/state.js");
    expect(state.readDashState().activePlot).toBe("existing");
  });
});

describe("garden plot delete", () => {
  it("refuses to delete the active plot", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { active: { projects: [] }, other: { projects: [] } },
    });
    await writeActivePlot("active");

    const { plot } = await import("../src/commands/plot.js");
    await expect(plot(["delete", "active"])).rejects.toThrow(/Cannot delete the active plot/);
  });

  it("deletes a non-active plot", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { active: { projects: [] }, gone: { projects: [] } },
    });
    await writeActivePlot("active");

    const { plot } = await import("../src/commands/plot.js");
    await captureConsoleLog(() => plot(["delete", "gone"]));

    const loaded = config.loadConfig();
    expect(loaded.plots).toEqual({ active: { projects: [] } });
  });
});

describe("garden plot (bare name activates)", () => {
  it("sets active-plot pointer when given a plot name", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { a: { projects: [] }, b: { projects: [] } },
    });
    await writeActivePlot("a");

    const { plot } = await import("../src/commands/plot.js");
    await captureConsoleLog(() => plot(["b"]));

    const state = await import("../src/dashboard/state.js");
    expect(state.readDashState().activePlot).toBe("b");
  });

  it("throws for an unknown subcommand or plot name", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { a: { projects: [] } } });

    const { plot } = await import("../src/commands/plot.js");
    await expect(plot(["nonexistent"])).rejects.toThrow(/Unknown plot subcommand or plot/);
  });
});
