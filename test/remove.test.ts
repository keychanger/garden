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

  // The status pane and the pollers resolve projects through the config, so a
  // removed project's workers keep running with no row, review or merge.
  it("refuses while the project has registered workers, naming them and the remedy", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" }, b: { path: "/b" } } });
    const registry = await import("../src/dashboard/registry.js");
    registry.addWorker("a", { name: "tall-fern", sessionId: "s1", task: "" });
    registry.addWorker("a", { name: "wide-oak", sessionId: "s2", task: "" });
    registry.addWorker("b", { name: "short-elm", sessionId: "s3", task: "" });

    const { remove } = await importRemove();
    await expect(remove(["a"])).rejects.toThrow(
      /'a' still has registered workers: a\/tall-fern, a\/wide-oak\..*garden workers stop <worker>/,
    );
    const loaded = config.loadConfig();
    expect(loaded.projects["a"]).toBeDefined();
    expect(registry.getWorkers("a").map(w => w.name)).toEqual(["tall-fern", "wide-oak"]);
  });

  it("removes a project whose only workers belong to other projects", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" }, b: { path: "/b" } } });
    const registry = await import("../src/dashboard/registry.js");
    registry.addWorker("b", { name: "short-elm", sessionId: "s3", task: "" });

    const { remove } = await importRemove();
    await captureConsoleLog(() => remove(["a"]));
    expect(config.loadConfig().projects["a"]).toBeUndefined();
    expect(registry.getWorkers("b")).toHaveLength(1);
  });

  it("refuses when the worker registry cannot be read", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const registry = await import("../src/dashboard/registry.js");
    registry.addWorker("a", { name: "tall-fern", sessionId: "s1", task: "" });
    const registryFile = path.join(config.SESSIONS_DIR, "dashboard.registry.json");
    expect(fs.existsSync(registryFile)).toBe(true);
    fs.chmodSync(registryFile, 0o000);
    try {
      const { remove } = await importRemove();
      await expect(remove(["a"])).rejects.toThrow(/registry could not be read/);
      expect(config.loadConfig().projects["a"]).toBeDefined();
    } finally {
      fs.chmodSync(registryFile, 0o600);
    }
  });

  it("confirms removal in console output", async () => {
    const config = await setup();
    config.saveConfig({ projects: { myproj: { path: "/myproj" } } });

    const { remove } = await importRemove();
    const logged = await captureConsoleLog(() => remove(["myproj"]));

    expect(logged.some(l => l.includes("Removed project 'myproj'"))).toBe(true);
  });
});
