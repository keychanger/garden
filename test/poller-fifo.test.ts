import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Wrap the real execFileSync so the default behaviour still shells out to a
// real mkfifo (the happy/idempotent paths assert on actual FIFOs), while
// individual tests can override the next call to simulate the cross-process
// creation race that ensureSignalFifo must tolerate.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

import { execFileSync } from "node:child_process";
import { ensureSignalFifo } from "../src/dashboard/poller-fifo.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-fifo-test-"));
  vi.mocked(execFileSync).mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ensureSignalFifo", () => {
  it("creates a FIFO and returns true when the path is absent", () => {
    const fifo = path.join(dir, "fresh-poll-signal");
    expect(ensureSignalFifo(fifo)).toBe(true);
    expect(fs.statSync(fifo).isFIFO()).toBe(true);
  });

  it("is idempotent: returns true without recreating an existing FIFO", () => {
    const fifo = path.join(dir, "idem-poll-signal");
    expect(ensureSignalFifo(fifo)).toBe(true);
    vi.mocked(execFileSync).mockClear();
    expect(ensureSignalFifo(fifo)).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled(); // took the isFIFO early return
  });

  it("replaces a non-FIFO file squatting the path", () => {
    const fifo = path.join(dir, "squat-poll-signal");
    fs.writeFileSync(fifo, "stale");
    expect(ensureSignalFifo(fifo)).toBe(true);
    expect(fs.statSync(fifo).isFIFO()).toBe(true);
  });

  it("returns false when a concurrent creator wins the mkfifo race", async () => {
    const { execFileSync: realExec } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fifo = path.join(dir, "race-poll-signal");
    // Simulate the racer: the FIFO appears between our stat (absent) and our
    // mkfifo, so our mkfifo fails "File exists" while the path is now a FIFO.
    vi.mocked(execFileSync).mockImplementationOnce(((cmd: string, mkfifoArgs: string[]) => {
      realExec(cmd, mkfifoArgs); // the winning process creates the FIFO
      throw new Error(`Command failed: mkfifo ${mkfifoArgs[0]}\nmkfifo: ${mkfifoArgs[0]}: File exists`);
    }) as typeof execFileSync);
    expect(ensureSignalFifo(fifo)).toBe(false);
    expect(fs.statSync(fifo).isFIFO()).toBe(true); // the winner's FIFO survives
  });

  it("rethrows when mkfifo fails for a non-race reason", () => {
    const fifo = path.join(dir, "broken-poll-signal");
    // mkfifo fails and no FIFO is left behind: a real failure, not the race.
    vi.mocked(execFileSync).mockImplementationOnce((() => {
      throw new Error("Command failed: mkfifo: command not found");
    }) as typeof execFileSync);
    expect(() => ensureSignalFifo(fifo)).toThrow(/command not found/);
  });
});
