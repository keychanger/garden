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

describe("garden reorder", () => {
  it("throws when missing args", async () => {
    await setup();
    const { reorder } = await import("../src/commands/reorder.js");
    await expect(reorder([])).rejects.toThrow("Usage:");
  });

  it("throws when position is missing", async () => {
    await setup();
    const { reorder } = await import("../src/commands/reorder.js");
    await expect(reorder(["imp"])).rejects.toThrow("Usage:");
  });

  it("throws when position is not a number", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { imp: { projects: [] } } });
    const { reorder } = await import("../src/commands/reorder.js");
    await expect(reorder(["imp", "xyz"])).rejects.toThrow("Invalid position: xyz");
  });

  it("steers users who pass a project name toward plot-level reorder", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a" } },
      plots: { imp: { projects: ["a"] } },
    });
    const { reorder } = await import("../src/commands/reorder.js");
    await expect(reorder(["a", "1"])).rejects.toThrow(/is a project, not a plot/);
  });

  it("reorders a plot within the cycle", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: {
        first: { projects: [] },
        second: { projects: [] },
        third: { projects: [] },
      },
    });

    const { reorder } = await import("../src/commands/reorder.js");
    await captureConsoleLog(() => reorder(["third", "1"]));

    const loaded = config.loadConfig();
    expect(Object.keys(loaded.plots!)).toEqual(["third", "first", "second"]);
  });
});
