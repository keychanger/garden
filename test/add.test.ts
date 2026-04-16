import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureConsoleLog } from "./helpers.js";

let tmpHome: string;
let originalHome: string | undefined;

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => false),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-add-test-"));
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

async function importAdd() {
  return await import("../src/commands/add.js");
}

import { dashboardExists } from "../src/session.js";
import { refreshDashboard } from "../src/dashboard/header.js";

describe("garden add", () => {
  it("adds a project by explicit path", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const projectDir = path.join(tmpHome, "myproject");
    fs.mkdirSync(projectDir);

    const { add } = await importAdd();
    await add([projectDir]);

    const loaded = config.loadConfig();
    expect(loaded.projects["myproject"]).toBeDefined();
    expect(loaded.projects["myproject"].path).toBe(projectDir);
  });

  it("throws when path does not exist", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });

    const { add } = await importAdd();
    await expect(add(["/nonexistent/path"])).rejects.toThrow("Path does not exist");
  });

  it("throws when path is a file, not a directory", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const filePath = path.join(tmpHome, "afile");
    fs.writeFileSync(filePath, "content");

    const { add } = await importAdd();
    await expect(add([filePath])).rejects.toThrow("Not a directory");
  });

  it("reports already added when re-adding same path", async () => {
    const config = await setup();
    const projectDir = path.join(tmpHome, "myproject");
    fs.mkdirSync(projectDir);
    config.saveConfig({ projects: { myproject: { path: projectDir } } });

    const { add } = await importAdd();
    const logged = await captureConsoleLog(() => add([projectDir]));

    expect(logged.some(l => l.includes("already added"))).toBe(true);
  });

  it("throws on name conflict with different path", async () => {
    const config = await setup();
    const projectDir = path.join(tmpHome, "myproject");
    fs.mkdirSync(projectDir);
    config.saveConfig({ projects: { myproject: { path: "/other/myproject" } } });

    const { add } = await importAdd();
    await expect(add([projectDir])).rejects.toThrow("already exists at /other/myproject");
  });

  it("calls refreshDashboard when dashboard is running", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const projectDir = path.join(tmpHome, "proj");
    fs.mkdirSync(projectDir);
    vi.mocked(dashboardExists).mockReturnValue(true);

    const { add } = await importAdd();
    await add([projectDir]);

    expect(refreshDashboard).toHaveBeenCalled();
  });

  it("rejects project names with tmux-special characters", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const projectDir = path.join(tmpHome, "my.project");
    fs.mkdirSync(projectDir);

    const { add } = await importAdd();
    await expect(add([projectDir])).rejects.toThrow("Invalid project name");
  });

  it("rejects project names containing reserved substrings", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const projectDir = path.join(tmpHome, "my-worker-test");
    fs.mkdirSync(projectDir);

    const { add } = await importAdd();
    await expect(add([projectDir])).rejects.toThrow("reserved for tmux");
  });

  it("does not call refreshDashboard when no dashboard", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const projectDir = path.join(tmpHome, "proj");
    fs.mkdirSync(projectDir);
    vi.mocked(dashboardExists).mockReturnValue(false);

    const { add } = await importAdd();
    await add([projectDir]);

    expect(refreshDashboard).not.toHaveBeenCalled();
  });
});
