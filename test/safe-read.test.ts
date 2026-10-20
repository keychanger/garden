import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { appendToStableFile, readStableRegularFile } from "../src/dashboard/safe-read.js";

// What a worker can leave at a path an unsandboxed reader is about to read.
describe("readStableRegularFile", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garden-safe-read-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garden-safe-read-outside-")));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("reads a regular file inside the root", () => {
    fs.writeFileSync(path.join(root, "goal.md"), "the goal\n");
    expect(readStableRegularFile(path.join(root, "goal.md"), root, 1024)?.data.toString()).toBe("the goal\n");
  });

  it("refuses a symlink, even to a file inside the root", () => {
    fs.writeFileSync(path.join(outside, "secret"), "credential\n");
    fs.symlinkSync(path.join(outside, "secret"), path.join(root, "out.md"));
    fs.writeFileSync(path.join(root, "real.md"), "real\n");
    fs.symlinkSync(path.join(root, "real.md"), path.join(root, "in.md"));
    expect(readStableRegularFile(path.join(root, "out.md"), root, 1024)).toBeNull();
    expect(readStableRegularFile(path.join(root, "in.md"), root, 1024)).toBeNull();
  });

  it("refuses a file reached through a symlinked directory that leaves the root", () => {
    fs.writeFileSync(path.join(outside, "goal.md"), "credential\n");
    fs.symlinkSync(outside, path.join(root, "dir"));
    expect(readStableRegularFile(path.join(root, "dir", "goal.md"), root, 1024)).toBeNull();
  });

  it("refuses a FIFO without waiting for a writer", () => {
    // Opening a FIFO for reading blocks until a writer appears, and the
    // poller's own signal FIFO always has one. A blocked open would also block
    // this test's thread past any vitest timeout, so a separate process opens
    // the FIFO for writing after 2s: a regression then fails on the elapsed
    // time instead of hanging the suite.
    const fifo = path.join(root, "goal.md");
    execFileSync("mkfifo", [fifo]);
    const writer = spawn("sh", ["-c", 'sleep 2; exec 3>"$1"', "sh", fifo], { stdio: "ignore" });
    try {
      const started = Date.now();
      expect(readStableRegularFile(fifo, root, 1024)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      writer.kill();
    }
  });

  it("refuses a hard link to a file elsewhere", () => {
    fs.writeFileSync(path.join(outside, "secret"), "credential\n");
    fs.linkSync(path.join(outside, "secret"), path.join(root, "goal.md"));
    expect(readStableRegularFile(path.join(root, "goal.md"), root, 1024)).toBeNull();
  });

  it("refuses a file over the size cap", () => {
    fs.writeFileSync(path.join(root, "goal.md"), "x".repeat(2048));
    expect(readStableRegularFile(path.join(root, "goal.md"), root, 1024)).toBeNull();
  });
});

describe("appendToStableFile", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garden-safe-append-")));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("appends to the file that was read", () => {
    const file = path.join(root, "exclude");
    fs.writeFileSync(file, "a\n");
    appendToStableFile(file, readStableRegularFile(file, root, 1024)!, "b\n");
    expect(fs.readFileSync(file, "utf8")).toBe("a\nb\n");
  });

  it("refuses a symlink swapped in after the read, leaving its target alone", () => {
    const file = path.join(root, "exclude");
    const target = path.join(root, "target");
    fs.writeFileSync(file, "a\n");
    fs.writeFileSync(target, "keep\n");
    const read = readStableRegularFile(file, root, 1024)!;
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    expect(() => appendToStableFile(file, read, "b\n")).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("keep\n");
  });

  it("refuses a file replaced since the read", () => {
    const file = path.join(root, "exclude");
    fs.writeFileSync(file, "a\n");
    const read = readStableRegularFile(file, root, 1024)!;
    // Written before the original goes away, so it cannot reuse its inode.
    fs.writeFileSync(path.join(root, "replacement"), "replacement\n");
    fs.renameSync(path.join(root, "replacement"), file);
    expect(() => appendToStableFile(file, read, "b\n")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("replacement\n");
  });
});
