import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-marker-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function markerPath(project: string, worker: string): string {
  return path.join(tmpDir, `claude-active-${project}-${worker}`);
}

// Inline the logic under test to avoid importing the full header module
// (which pulls in tmux, state, registry, etc.).  This mirrors the production
// code exactly — if the implementation changes, this test should be updated.
const MARKER_STALE_MS = 5 * 60 * 1000;

function isClaudeActiveByHook(project: string, worker: string): boolean {
  try {
    const p = markerPath(project, worker);
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > MARKER_STALE_MS) {
      fs.unlinkSync(p);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

describe("isClaudeActiveByHook stale marker expiry", () => {
  it("returns true for a fresh marker", () => {
    const p = markerPath("proj", "w1");
    fs.writeFileSync(p, "1");
    expect(isClaudeActiveByHook("proj", "w1")).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("returns false and deletes a stale marker", () => {
    const p = markerPath("proj", "w1");
    fs.writeFileSync(p, "1");
    // Backdate the mtime by 6 minutes
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    fs.utimesSync(p, new Date(sixMinAgo), new Date(sixMinAgo));

    expect(isClaudeActiveByHook("proj", "w1")).toBe(false);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("returns false when no marker exists", () => {
    expect(isClaudeActiveByHook("proj", "w1")).toBe(false);
  });

  it("returns true for a marker just under the threshold", () => {
    const p = markerPath("proj", "w1");
    fs.writeFileSync(p, "1");
    // Set mtime to 4 minutes ago (under 5-minute threshold)
    const fourMinAgo = Date.now() - 4 * 60 * 1000;
    fs.utimesSync(p, new Date(fourMinAgo), new Date(fourMinAgo));

    expect(isClaudeActiveByHook("proj", "w1")).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });
});
