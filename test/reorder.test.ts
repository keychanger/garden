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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-reorder-test-"));
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

describe("garden reorder", () => {
  it("throws when missing args", async () => {
    await setup();
    const { reorder } = await import("../src/commands/reorder.js");
    await expect(reorder([])).rejects.toThrow("Usage:");
  });

  it("throws when position is missing", async () => {
    await setup();
    const { reorder } = await import("../src/commands/reorder.js");
    await expect(reorder(["a"])).rejects.toThrow("Usage:");
  });

  it("throws when position is not a number", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const { reorder } = await import("../src/commands/reorder.js");
    await expect(reorder(["a", "xyz"])).rejects.toThrow("Invalid position: xyz");
  });

  it("reorders project to new position", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {
        a: { path: "/a" },
        b: { path: "/b" },
        c: { path: "/c" },
      },
    });

    const { reorder } = await import("../src/commands/reorder.js");
    await captureConsoleLog(() => reorder(["c", "1"]));

    const loaded = config.loadConfig();
    expect(Object.keys(loaded.projects)).toEqual(["c", "a", "b"]);
  });

  it("calls refreshDashboard after reorder", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" }, b: { path: "/b" } } });

    const { reorder } = await import("../src/commands/reorder.js");
    await captureConsoleLog(() => reorder(["b", "1"]));

    expect(refreshDashboard).toHaveBeenCalled();
  });
});
