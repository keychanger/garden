import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/config.js", async () => {
  const os = await import("node:os");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  return { GARDEN_DIR: nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "garden-diary-")) };
});

import { GARDEN_DIR } from "../src/config.js";
import { DIARY_DIR, diaryFilePath } from "../src/diary.js";

describe("diaryFilePath", () => {
  it("returns the per-project diary path under ~/.garden/diary", () => {
    expect(diaryFilePath("garden")).toBe(path.join(GARDEN_DIR, "diary", "garden.md"));
  });

  it("creates the diary directory so callers can write immediately", () => {
    const file = diaryFilePath("other");
    expect(fs.existsSync(DIARY_DIR)).toBe(true);
    fs.writeFileSync(file, "vacation thoughts\n");
    expect(fs.readFileSync(file, "utf-8")).toBe("vacation thoughts\n");
  });

  it("is idempotent when the directory already exists", () => {
    expect(diaryFilePath("garden")).toBe(diaryFilePath("garden"));
  });
});
