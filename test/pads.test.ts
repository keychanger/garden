import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/config.js", async () => {
  const os = await import("node:os");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  return { GARDEN_DIR: nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "garden-pads-")) };
});

import { GARDEN_DIR } from "../src/config.js";
import { PADS_DIR, padFilePath } from "../src/pads.js";

describe("padFilePath", () => {
  it("returns the per-project pad path under ~/.garden/pads", () => {
    expect(padFilePath("garden")).toBe(path.join(GARDEN_DIR, "pads", "garden.md"));
  });

  it("creates the pads directory so callers can write immediately", () => {
    const file = padFilePath("other");
    expect(fs.existsSync(PADS_DIR)).toBe(true);
    fs.writeFileSync(file, "vacation thoughts\n");
    expect(fs.readFileSync(file, "utf-8")).toBe("vacation thoughts\n");
  });

  it("is idempotent when the directory already exists", () => {
    expect(padFilePath("garden")).toBe(padFilePath("garden"));
  });
});
