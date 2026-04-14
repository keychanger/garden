import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureConsoleLog } from "./helpers.js";

let tmpHome: string;
let originalHome: string | undefined;

vi.mock("../src/session.js", () => ({
  checkTmux: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-init-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

import { checkTmux } from "../src/session.js";

describe("garden init", () => {
  it("creates config file with empty projects when not initialized", async () => {
    const config = await import("../src/config.js");
    // Garden dir may not exist yet — init should create it
    fs.mkdirSync(path.join(tmpHome, ".garden"), { recursive: true });

    const { init } = await import("../src/commands/init.js");
    const lines = await captureConsoleLog(() => init());

    expect(lines.some(l => l.includes("Initialized garden"))).toBe(true);
    expect(fs.existsSync(config.CONFIG_PATH)).toBe(true);

    const loaded = config.loadConfig();
    expect(loaded.projects).toEqual({});
  });

  it("reports already initialized when config exists", async () => {
    const config = await import("../src/config.js");
    fs.mkdirSync(config.GARDEN_DIR, { recursive: true });
    fs.mkdirSync(config.SESSIONS_DIR, { recursive: true });
    config.saveConfig({ projects: { a: { path: "/a" }, b: { path: "/b" } } });

    const { init } = await import("../src/commands/init.js");
    const lines = await captureConsoleLog(() => init());

    expect(lines.some(l => l.includes("already initialized") && l.includes("2 projects"))).toBe(true);
  });

  it("throws when tmux is not installed", async () => {
    vi.mocked(checkTmux).mockImplementation(() => {
      throw new Error("tmux is not installed");
    });

    const { init } = await import("../src/commands/init.js");
    await expect(init()).rejects.toThrow("tmux is not installed");
  });
});
