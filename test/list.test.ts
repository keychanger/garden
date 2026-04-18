import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureConsoleLog } from "./helpers.js";

let tmpHome: string;
let originalHome: string | undefined;

const mockOutput = vi.fn();
vi.mock("../src/output.js", () => ({
  output: (...args: unknown[]) => mockOutput(...args),
  isTTY: true,
}));

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-list-test-"));
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

async function importList() {
  return await import("../src/commands/list.js");
}

describe("garden list", () => {
  it("prints message when no projects exist", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });

    const { list } = await importList();
    const lines = await captureConsoleLog(() => list());

    expect(lines.some(l => l.includes("No projects added"))).toBe(true);
  });

  it("passes structured ProjectInfo array to output()", async () => {
    const config = await setup();
    config.saveConfig({ projects: { alpha: { path: "/alpha" }, beta: { path: "/beta" } } });

    const { list } = await importList();
    await list();

    expect(mockOutput).toHaveBeenCalledOnce();
    const data = mockOutput.mock.calls[0][0];
    expect(data).toEqual([
      { name: "alpha", path: "/alpha", index: 1 },
      { name: "beta", path: "/beta", index: 2 },
    ]);
  });

  it("pretty-printer shows index, name, and path", async () => {
    const config = await setup();
    config.saveConfig({ projects: { myproj: { path: "/my/project" } } });

    const { list } = await importList();
    await list();

    const pretty = mockOutput.mock.calls[0][1] as (data: unknown) => string;
    const formatted = pretty(mockOutput.mock.calls[0][0]);
    expect(formatted).toContain("1.");
    expect(formatted).toContain("myproj");
    expect(formatted).toContain("/my/project");
  });
});
