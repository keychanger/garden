import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-config-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function importConfig() {
  return await import("../src/config.js");
}

describe("loadConfig", () => {
  it("throws when not initialized", async () => {
    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow("Garden is not initialized");
  });

  it("returns empty projects after init", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    const config = loadConfig();
    expect(config.projects).toEqual({});
  });
});

describe("getProject", () => {
  it("returns a registered project", async () => {
    const { getProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { test: { path: "/tmp/test" } } });
    const project = getProject("test");
    expect(project.name).toBe("test");
    expect(project.path).toBe("/tmp/test");
  });

  it("throws for unknown project", async () => {
    const { getProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(() => getProject("nope")).toThrow("Unknown project: nope");
  });
});

describe("tryGetProject", () => {
  it("returns null for unknown project", async () => {
    const { tryGetProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(tryGetProject("nope")).toBeNull();
  });
});

describe("resolveProject", () => {
  it("resolves from explicit name", async () => {
    const { resolveProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { myproj: { path: "/tmp/myproj" } } });
    const project = resolveProject("myproj");
    expect(project.name).toBe("myproj");
  });

  it("resolves from GARDEN_PROJECT env var", async () => {
    const { resolveProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { envproj: { path: "/tmp/envproj" } } });
    process.env.GARDEN_PROJECT = "envproj";
    try {
      const project = resolveProject();
      expect(project.name).toBe("envproj");
    } finally {
      delete process.env.GARDEN_PROJECT;
    }
  });

  it("throws when no project can be resolved", async () => {
    const { resolveProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(() => resolveProject()).toThrow("No project specified");
  });
});
