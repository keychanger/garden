// The `garden limits` command: it reads/writes the garden-level LimitsConfig
// via the shared getters/setter (covered structurally in config.test.ts), so
// here we exercise the command's own parsing, validation, and clear tokens
// against a redirected HOME (real config file, no mocks).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-limits-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function setup() {
  const cfg = await import("../src/config.js");
  const { limits } = await import("../src/commands/limits.js");
  fs.mkdirSync(cfg.GARDEN_DIR, { recursive: true });
  cfg.saveConfig({ projects: {} });
  return { limits, ...cfg };
}

describe("garden limits", () => {
  it("sets and clears max-reviews (0 stores nothing)", async () => {
    const { limits, getMaxConcurrentReviews, loadConfig } = await setup();
    await limits(["max-reviews", "3"]);
    expect(getMaxConcurrentReviews()).toBe(3);
    await limits(["max-reviews", "0"]);
    expect(getMaxConcurrentReviews()).toBe(0);
    expect(loadConfig().limits).toBeUndefined();
  });

  it("sets and clears checks-slots via an explicit unset", async () => {
    const { limits, getChecksSlotsOverride } = await setup();
    await limits(["checks-slots", "2"]);
    expect(getChecksSlotsOverride()).toBe(2);
    await limits(["checks-slots", "unset"]);
    expect(getChecksSlotsOverride()).toBeUndefined();
  });

  it("rejects a non-integer / out-of-range value", async () => {
    const { limits } = await setup();
    await expect(limits(["checks-slots", "0"])).rejects.toThrow(/integer >= 1/);
    await expect(limits(["checks-slots", "abc"])).rejects.toThrow(/integer >= 1/);
    await expect(limits(["max-reviews", "-1"])).rejects.toThrow(/integer >= 0/);
  });

  it("rejects an unknown subcommand", async () => {
    const { limits } = await setup();
    await expect(limits(["bogus"])).rejects.toThrow(/Unknown subcommand/);
  });

  it("status is a no-op read that does not create a limits block", async () => {
    const { limits, loadConfig } = await setup();
    await limits(["status"]);
    expect(loadConfig().limits).toBeUndefined();
  });
});
