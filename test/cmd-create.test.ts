import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;
let activePlot: string | null = null;

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: () => ({ activePlot }),
}));

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => false),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  activePlot = null;
  execFileSyncMock.mockImplementation(() => "");
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-create-test-"));
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

async function importCreate() {
  return await import("../src/commands/create.js");
}

describe("garden create", () => {
  it("throws when no path is given", async () => {
    await setup();
    const { create } = await importCreate();
    await expect(create([])).rejects.toThrow("Usage: garden create");
  });

  it("rejects names with reserved tmux substrings before any side effects", async () => {
    await setup();
    const { create } = await importCreate();
    const target = path.join(tmpHome, "my-worker-1");
    await expect(create([target])).rejects.toThrow("reserved for tmux");
    expect(fs.existsSync(target)).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("throws when a project with the same name is already registered", async () => {
    const config = await setup();
    config.saveConfig({ projects: { taken: { path: "/elsewhere/taken" } } });
    const { create } = await importCreate();
    await expect(create([path.join(tmpHome, "taken")])).rejects.toThrow(
      "already exists at /elsewhere/taken",
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("throws when the target path already exists", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const target = path.join(tmpHome, "existing");
    fs.mkdirSync(target);
    const { create } = await importCreate();
    await expect(create([target])).rejects.toThrow("Path already exists");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("throws when the active plot is missing from config", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: {} });
    activePlot = "phantom";
    const { create } = await importCreate();
    await expect(create([path.join(tmpHome, "newproj")])).rejects.toThrow(
      "Active plot 'phantom' is missing",
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("refuses to create when the active plot is full, before touching git or GitHub", async () => {
    const config = await setup();
    const filler = Array.from({ length: 9 }, (_, i) => `p${i}`);
    const projects: Record<string, { path: string }> = {};
    for (const p of filler) projects[p] = { path: `/x/${p}` };
    config.saveConfig({
      projects,
      plots: { full: { projects: filler } },
    });
    activePlot = "full";

    const target = path.join(tmpHome, "newproj");
    const { create } = await importCreate();
    await expect(create([target])).rejects.toThrow(/full \(9 projects\)/);
    expect(fs.existsSync(target)).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("scaffolds dir, runs git + gh, and registers project on the active plot", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { all: { projects: [] } },
    });
    activePlot = "all";

    const target = path.join(tmpHome, "shiny");
    const { create } = await importCreate();
    await create([target]);

    expect(fs.existsSync(path.join(target, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf-8")).toContain("# shiny");

    const calls = execFileSyncMock.mock.calls.map(c => [c[0], c[1]]);
    expect(calls).toEqual([
      ["git", ["init", "-b", "main"]],
      ["git", ["add", "README.md"]],
      ["git", ["commit", "-m", "Initial commit"]],
      ["gh", ["repo", "create", "keychange/shiny", "--private", "--source=.", "--remote=origin", "--push"]],
    ]);

    const loaded = config.loadConfig();
    expect(loaded.projects["shiny"].path).toBe(target);
    expect(loaded.plots?.all.projects).toContain("shiny");
  });

  it("registers without a plot when none is active and prints a hint", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    activePlot = null;

    const target = path.join(tmpHome, "loner");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      const { create } = await importCreate();
      await create([target]);
    } finally {
      console.log = orig;
    }

    const loaded = config.loadConfig();
    expect(loaded.projects["loner"].path).toBe(target);
    expect(logs.some(l => l.includes("No active plot"))).toBe(true);
  });
});
