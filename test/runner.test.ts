import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
  },
}));

import fs from "node:fs";
import { resolveGardenRunner } from "../src/dashboard/runner.js";

const savedArgv1 = process.argv[1];
afterAll(() => { process.argv[1] = savedArgv1; });

beforeEach(() => {
  vi.clearAllMocks();
  process.argv[1] = "/usr/local/bin/garden";
});

describe("resolveGardenRunner", () => {
  it("uses node with absolute path for compiled .js binary", () => {
    process.argv[1] = "/usr/local/bin/garden";
    const result = resolveGardenRunner();
    expect(result).toContain(process.execPath);
    expect(result).toContain("/usr/local/bin/garden");
  });

  it("uses tsx when argv ends in .ts and tsx binary exists", () => {
    process.argv[1] = "/code/garden/src/cli.ts";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = resolveGardenRunner();
    expect(result).toContain("tsx");
    expect(result).toContain("/code/garden/src/cli.ts");
  });

  it("falls back to npx tsx when tsx binary not found", () => {
    process.argv[1] = "/code/garden/src/cli.ts";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = resolveGardenRunner();
    expect(result).toContain("npx tsx");
    expect(result).toContain("/code/garden/src/cli.ts");
  });
});
