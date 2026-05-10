// Regression test for the FIFO-poke survival bug: scheduleDelayedPoke must
// deliver its byte even when the calling Node process exits before any
// timer would fire. Every scheduleDelayedPoke caller runs inside a
// short-lived `_poll <project>` Node child the bash poll loop spawns per
// tick — an in-process `setTimeout(...).unref()` is dropped at that exit
// (Node terminates unref'd timers when the event loop empties), so the
// previous in-process implementation silently lost every poke and stranded
// workers in `merge-pending`, `failing → working` debounce, etc.
//
// We can't reproduce that lifecycle in vitest's own process (vitest never
// exits during the test), so the test spawns a real child that imports the
// function via tsx, calls it, and exits. The byte must arrive in the FIFO
// after the child is gone.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const PROJECT = "fifoprobe";

let tmpHome: string;
let fifo: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-fifo-test-"));
  fs.mkdirSync(path.join(tmpHome, ".garden", "sessions"), { recursive: true });
  fifo = path.join(tmpHome, ".garden", "sessions", `${PROJECT}-poll-signal`);
  execFileSync("mkfifo", [fifo]);
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Read from an already-open FIFO fd with a hard timeout. The fd is held
// open by the caller (so the writer's bytes survive in the kernel buffer);
// this just races the read against a timer.
async function readFdWithTimeout(fd: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`FIFO read timed out after ${timeoutMs}ms — poke never arrived`));
    }, timeoutMs);
    const buf = Buffer.alloc(64);
    fs.read(fd, buf, 0, buf.length, null, (err, bytesRead) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(buf.subarray(0, bytesRead).toString("utf8"));
    });
  });
}

describe("scheduleDelayedPoke (real FIFO, real child process)", () => {
  it("delivers the poke even when the calling process exits before any in-process timer would fire", async () => {
    const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
    const fifoSrc = path.resolve(process.cwd(), "src/dashboard/poller-fifo.ts");

    // Pre-open the FIFO for read+write so a reader is present when the
    // detached writer fires. Mirrors the production poller's `exec 3<>${fifo}`
    // — without a held-open reader, the kernel reclaims the buffered byte the
    // instant the writer closes and a later open(O_RDONLY) blocks forever.
    // This open also doubles as the pipe through which we observe the byte.
    const readFd = fs.openSync(fifo, fs.constants.O_RDWR);

    try {
      // The child imports scheduleDelayedPoke, calls it with delayMs=0, then
      // exits synchronously. Under the buggy in-process setTimeout(...).unref()
      // implementation, the timer is dropped at exit and the FIFO never sees
      // the byte. Under the fixed detached-subprocess implementation, the
      // detached bash survives and writes the byte after the child is gone.
      const childCode = `
        import { scheduleDelayedPoke } from ${JSON.stringify(fifoSrc)};
        scheduleDelayedPoke(${JSON.stringify(PROJECT)}, 0);
        process.exit(0);
      `;
      const result = spawnSync(tsxBin, ["-e", childCode], {
        env: { ...process.env, HOME: tmpHome },
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status).toBe(0);

      const got = await readFdWithTimeout(readFd, 5_000);
      expect(got.length).toBeGreaterThan(0);
    } finally {
      try { fs.closeSync(readFd); } catch { /* already closed */ }
    }
  });
});
