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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-order-test-"));
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

describe("garden order", () => {
  it("throws when missing args", async () => {
    await setup();
    const { order } = await import("../src/commands/order.js");
    await expect(order([])).rejects.toThrow("Usage:");
  });

  it("throws when position is missing", async () => {
    await setup();
    const { order } = await import("../src/commands/order.js");
    await expect(order(["a"])).rejects.toThrow("Usage:");
  });

  it("throws when position is not a number", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const { order } = await import("../src/commands/order.js");
    await expect(order(["a", "xyz"])).rejects.toThrow("Invalid position: xyz");
  });

  it("orders project to new position", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {
        a: { path: "/a" },
        b: { path: "/b" },
        c: { path: "/c" },
      },
    });

    const { order } = await import("../src/commands/order.js");
    await captureConsoleLog(() => order(["c", "1"]));

    const loaded = config.loadConfig();
    expect(Object.keys(loaded.projects)).toEqual(["c", "a", "b"]);
  });

  it("positions refer to focused projects only", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {
        a: { path: "/a" },
        b: { path: "/b", focused: false },
        c: { path: "/c" },
        d: { path: "/d" },
      },
    });

    const { order } = await import("../src/commands/order.js");
    const output = await captureConsoleLog(() => order(["d", "1"]));

    const loaded = config.loadConfig();
    expect(Object.keys(loaded.projects)).toEqual(["d", "b", "a", "c"]);
    const joined = output.join("\n");
    expect(joined).not.toMatch(/\b\d+\.\s+b\b/);
    expect(joined).toMatch(/1\.\s+d/);
    expect(joined).toMatch(/2\.\s+a/);
    expect(joined).toMatch(/3\.\s+c/);
  });

  it("refuses to order an unfocused project", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {
        a: { path: "/a" },
        b: { path: "/b", focused: false },
      },
    });

    const { order } = await import("../src/commands/order.js");
    await expect(order(["b", "1"])).rejects.toThrow(
      "Cannot order unfocused project 'b'"
    );
  });

  it("is callable as the reorder alias", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a" }, b: { path: "/b" } },
    });

    const { commands } = await import("../src/commands/index.js");
    // The alias resolves in cli.ts; verify the target command is registered as `order`.
    expect(commands.order).toBeDefined();
    expect(commands.reorder).toBeUndefined();
  });

  it("calls refreshDashboard after order", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" }, b: { path: "/b" } } });

    const { order } = await import("../src/commands/order.js");
    await captureConsoleLog(() => order(["b", "1"]));

    expect(refreshDashboard).toHaveBeenCalled();
  });
});
