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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-focus-test-"));
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

describe("garden focus", () => {
  it("throws when no name arg given", async () => {
    await setup();
    const { focus } = await import("../src/commands/focus.js");
    await expect(focus([])).rejects.toThrow("Usage: garden focus <plot>");
  });

  it("throws for unknown plot", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: {} });
    const { focus } = await import("../src/commands/focus.js");
    await expect(focus(["ghost"])).rejects.toThrow("Unknown plot: ghost");
  });

  it("steers users who pass a project name toward the plot commands", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } }, plots: {} });
    const { focus } = await import("../src/commands/focus.js");
    await expect(focus(["a"])).rejects.toThrow(/is a project, not a plot/);
  });

  it("reports already focused for a focused plot", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { imp: { projects: [] } } });
    const { focus } = await import("../src/commands/focus.js");
    const lines = await captureConsoleLog(() => focus(["imp"]));
    expect(lines.some(l => l.includes("already focused"))).toBe(true);
  });

  it("focuses a previously unfocused plot", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { imp: { projects: [], focused: false } },
    });
    const { focus } = await import("../src/commands/focus.js");
    const lines = await captureConsoleLog(() => focus(["imp"]));
    expect(lines.some(l => l.includes("Focused plot 'imp'"))).toBe(true);
    const loaded = config.loadConfig();
    expect(loaded.plots?.imp).not.toHaveProperty("focused");
  });
});

describe("garden unfocus", () => {
  it("throws when no name arg given", async () => {
    await setup();
    const { unfocus } = await import("../src/commands/focus.js");
    await expect(unfocus([])).rejects.toThrow("Usage: garden unfocus <plot>");
  });

  it("throws for unknown plot", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: {} });
    const { unfocus } = await import("../src/commands/focus.js");
    await expect(unfocus(["ghost"])).rejects.toThrow("Unknown plot: ghost");
  });

  it("reports already unfocused", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { imp: { projects: [], focused: false } },
    });
    const { unfocus } = await import("../src/commands/focus.js");
    const lines = await captureConsoleLog(() => unfocus(["imp"]));
    expect(lines.some(l => l.includes("already unfocused"))).toBe(true);
  });

  it("unfocuses a focused plot", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { imp: { projects: [] } } });
    const { unfocus } = await import("../src/commands/focus.js");
    const lines = await captureConsoleLog(() => unfocus(["imp"]));
    expect(lines.some(l => l.includes("Unfocused plot 'imp'"))).toBe(true);
    const loaded = config.loadConfig();
    expect(loaded.plots?.imp.focused).toBe(false);
  });
});
