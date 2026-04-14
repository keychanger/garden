import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureConsoleLog } from "./helpers.js";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-remove-test-"));
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

async function importRemove() {
  return await import("../src/commands/remove.js");
}

describe("garden remove", () => {
  it("throws when no name arg given", async () => {
    await setup();
    const { remove } = await importRemove();
    await expect(remove([])).rejects.toThrow("Usage: garden remove <name>");
  });

  it("throws for unknown project", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });

    const { remove } = await importRemove();
    await expect(remove(["ghost"])).rejects.toThrow("Unknown project: ghost");
  });

  it("removes existing project from config", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" }, b: { path: "/b" } } });

    const { remove } = await importRemove();
    await remove(["a"]);

    const loaded = config.loadConfig();
    expect(loaded.projects["a"]).toBeUndefined();
    expect(loaded.projects["b"]).toBeDefined();
  });

  it("confirms removal in console output", async () => {
    const config = await setup();
    config.saveConfig({ projects: { myproj: { path: "/myproj" } } });

    const { remove } = await importRemove();
    const logged = await captureConsoleLog(() => remove(["myproj"]));

    expect(logged.some(l => l.includes("Removed project 'myproj'"))).toBe(true);
  });
});
