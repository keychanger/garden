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

import { refreshDashboard } from "../src/dashboard/header.js";

describe("garden focus", () => {
  it("throws when no name arg given", async () => {
    await setup();
    const { focus } = await import("../src/commands/focus.js");
    await expect(focus([])).rejects.toThrow("Usage: garden focus <project>");
  });

  it("throws for unknown project", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const { focus } = await import("../src/commands/focus.js");
    await expect(focus(["ghost"])).rejects.toThrow("Unknown project: ghost");
  });

  it("reports already focused when project has no focused field", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const { focus } = await import("../src/commands/focus.js");

    const lines = await captureConsoleLog(() => focus(["a"]));
    expect(lines.some(l => l.includes("already focused"))).toBe(true);
    expect(refreshDashboard).not.toHaveBeenCalled();
  });

  it("focuses a previously unfocused project", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a", focused: false } } });
    const { focus } = await import("../src/commands/focus.js");

    const lines = await captureConsoleLog(() => focus(["a"]));

    expect(lines.some(l => l.includes("Focused 'a'"))).toBe(true);
    expect(refreshDashboard).toHaveBeenCalled();

    const loaded = config.loadConfig();
    expect(loaded.projects["a"].focused).toBeUndefined();
  });
});

describe("garden unfocus", () => {
  it("throws when no name arg given", async () => {
    await setup();
    const { unfocus } = await import("../src/commands/focus.js");
    await expect(unfocus([])).rejects.toThrow("Usage: garden unfocus <project>");
  });

  it("throws for unknown project", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const { unfocus } = await import("../src/commands/focus.js");
    await expect(unfocus(["ghost"])).rejects.toThrow("Unknown project: ghost");
  });

  it("reports already unfocused", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a", focused: false } } });
    const { unfocus } = await import("../src/commands/focus.js");

    const lines = await captureConsoleLog(() => unfocus(["a"]));
    expect(lines.some(l => l.includes("already unfocused"))).toBe(true);
    expect(refreshDashboard).not.toHaveBeenCalled();
  });

  it("unfocuses a focused project", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const { unfocus } = await import("../src/commands/focus.js");

    const lines = await captureConsoleLog(() => unfocus(["a"]));

    expect(lines.some(l => l.includes("Unfocused 'a'"))).toBe(true);
    expect(refreshDashboard).toHaveBeenCalled();

    const loaded = config.loadConfig();
    expect(loaded.projects["a"].focused).toBe(false);
  });
});
