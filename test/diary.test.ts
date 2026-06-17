import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/config.js", async () => {
  const os = await import("node:os");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  return { GARDEN_DIR: nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "garden-diary-")) };
});

import { GARDEN_DIR } from "../src/config.js";
import { DIARY_DIR, diaryFilePath, diaryHasContent, editorIsNano, _resetDiaryContentCacheForTest } from "../src/diary.js";

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

describe("diaryHasContent", () => {
  beforeEach(() => {
    _resetDiaryContentCacheForTest();
  });

  it("is false when the diary file does not exist", () => {
    expect(diaryHasContent("never-written")).toBe(false);
  });

  it("is false for an empty or whitespace-only file (e.g. a stray newline)", () => {
    fs.writeFileSync(diaryFilePath("empty"), "");
    fs.writeFileSync(diaryFilePath("blank"), "\n");
    fs.writeFileSync(diaryFilePath("spaces"), "   \n\t\n");
    expect(diaryHasContent("empty")).toBe(false);
    expect(diaryHasContent("blank")).toBe(false);
    expect(diaryHasContent("spaces")).toBe(false);
  });

  it("is true when the diary holds non-whitespace content", () => {
    fs.writeFileSync(diaryFilePath("noted"), "start small\n");
    expect(diaryHasContent("noted")).toBe(true);
  });

  it("reflects edits after the file changes (cache keys on mtime+size)", () => {
    const file = diaryFilePath("evolving");
    fs.writeFileSync(file, "");
    expect(diaryHasContent("evolving")).toBe(false);
    fs.writeFileSync(file, "now there are notes\n");
    expect(diaryHasContent("evolving")).toBe(true);
  });
});

describe("editorIsNano", () => {
  it("recognizes bare nano and pico (macOS `nano` is a symlink to pico)", () => {
    expect(editorIsNano("nano")).toBe(true);
    expect(editorIsNano("pico")).toBe(true);
  });

  it("recognizes a full path to nano/pico", () => {
    expect(editorIsNano("/usr/bin/nano")).toBe(true);
    expect(editorIsNano("/usr/bin/pico")).toBe(true);
  });

  it("recognizes nano/pico carrying arguments", () => {
    expect(editorIsNano("nano -l")).toBe(true);
    expect(editorIsNano("/usr/bin/pico -t")).toBe(true);
  });

  it("is false for other editors", () => {
    expect(editorIsNano("vim")).toBe(false);
    expect(editorIsNano("code -w")).toBe(false);
    expect(editorIsNano("/usr/local/bin/emacs")).toBe(false);
  });
});
