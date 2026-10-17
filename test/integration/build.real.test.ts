// The build's deployment invariants, against the real script and real esbuild.
// The live fleet runs dist/cli.js and dist/hook.js on every hook and poll, so a
// bundle must be renamed into place rather than rewritten in place (a process
// starting mid-build would load a truncated file), and dist/cli.js must stay
// executable: `garden` on PATH is a symlink to it, and a renamed-in file does
// not inherit the old one's mode.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const BUNDLES = ["dist/cli.js", "dist/hook.js"];

function inode(file: string): number | undefined {
  try {
    return fs.statSync(path.join(ROOT, file)).ino;
  } catch {
    return undefined;
  }
}

describe("build script (real esbuild)", () => {
  it("renames executable bundles into place", () => {
    const before = BUNDLES.map(inode);

    execFileSync("node", ["scripts/build.mjs"], { cwd: ROOT, stdio: "pipe", timeout: 120_000 });

    BUNDLES.forEach((file, i) => {
      const stat = fs.statSync(path.join(ROOT, file));
      expect(stat.mode & 0o111).toBe(0o111);
      if (before[i] !== undefined) expect(stat.ino).not.toBe(before[i]);
    });
    expect(fs.readdirSync(path.join(ROOT, "dist")).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });
});
