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
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    // The delayed poke spawns a detached timer; capture its script instead of
    // leaving a real one behind for the length of the delay.
    spawn: vi.fn(() => ({ unref: () => {} })),
  };
});

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  ensureSignalFifo, fifoPokeShell, pollerSpawnLockPath, scheduleDelayedPoke, signalFifoPath, triggerProjectPoll,
} from "../src/dashboard/poller-fifo.js";
import { withFileLock } from "../src/dashboard/file-lock.js";
import { SESSIONS_DIR } from "../src/config.js";
import { CONTROL_DIR } from "../src/paths.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-fifo-test-"));
  vi.mocked(execFileSync).mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The poll FIFO sits in the worker-writable sessions dir, and every poke runs
// unsandboxed: a symlink or a plain file a worker leaves at the path must not
// take the write.
describe("pokes", () => {
  function pokePath(project: string): string {
    const fifo = signalFifoPath(project);
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    fs.rmSync(fifo, { force: true });
    return fifo;
  }
  const shellPoke = (fifo: string) =>
    spawnSync("bash", ["-c", fifoPokeShell(`'${fifo}'`)], { timeout: 5_000 });

  it("write nothing through a symlink planted at the FIFO path", () => {
    const victim = path.join(dir, "victim.yml");
    fs.writeFileSync(victim, "projects:\n");
    const fifo = pokePath("proj-link");
    fs.symlinkSync(victim, fifo);

    triggerProjectPoll("proj-link");
    shellPoke(fifo);

    expect(fs.readFileSync(victim, "utf8")).toBe("projects:\n");
  });

  it("write nothing into a plain file left at the FIFO path", () => {
    const fifo = pokePath("proj-file");
    fs.writeFileSync(fifo, "operator-data");

    triggerProjectPoll("proj-file");
    shellPoke(fifo);

    expect(fs.readFileSync(fifo, "utf8")).toBe("operator-data");
  });

  it("write nothing through a symlink that points at a live FIFO", () => {
    // The link-to-plain-file case above is already refused by the descriptor
    // checks, so it passes with or without the link guards. Only a link whose
    // target is itself a FIFO distinguishes them: without O_NOFOLLOW and the
    // shell's `! -L`, the unsandboxed poke lands in a FIFO the worker chose.
    const target = path.join(dir, "elsewhere-fifo");
    execFileSync("mkfifo", [target]);
    const fifo = pokePath("proj-fifo-link");
    fs.symlinkSync(target, fifo);
    const reader = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      triggerProjectPoll("proj-fifo-link");
      shellPoke(fifo);
      let read = 0;
      try {
        read = fs.readSync(reader, Buffer.alloc(8), 0, 8, null);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      }
      expect(read).toBe(0);
    } finally {
      fs.closeSync(reader);
    }
  });

  it("leak no descriptor when a plain file sits at the FIFO path", () => {
    // The poke runs in long-lived unsandboxed processes (the watchdog tick,
    // the pollers, the usage poller), so a descriptor left behind on every
    // poke trends toward an fd exhaustion that fails spawns machine-wide.
    const fifo = pokePath("proj-fd-leak");
    fs.writeFileSync(fifo, "operator-data");
    const open = () => fs.readdirSync("/dev/fd").length;
    triggerProjectPoll("proj-fd-leak"); // warm any lazy module state
    const before = open();
    for (let i = 0; i < 20; i++) triggerProjectPoll("proj-fd-leak");
    expect(open()).toBeLessThanOrEqual(before + 2);
  });

  it("wake a poller reading the FIFO", () => {
    const fifo = pokePath("proj-live");
    execFileSync("mkfifo", [fifo]);
    const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      triggerProjectPoll("proj-live");
      shellPoke(fifo);
      expect(fs.readSync(reader, Buffer.alloc(8), 0, 8, null)).toBe(2);
    } finally {
      fs.closeSync(reader);
    }
  });

  it("write nothing from a shell when the path is swapped after its checks", () => {
    // A shell cannot open without following a link, so a worker that swaps the
    // FIFO out between the path checks and the open must still get no write.
    // This `[` passes the path checks, as they would just before such a swap.
    const victim = path.join(dir, "victim.yml");
    fs.writeFileSync(victim, "projects:\n");
    const link = path.join(dir, "swapped-link");
    fs.symlinkSync(victim, link);
    const plain = path.join(dir, "swapped-file");
    fs.writeFileSync(plain, "operator-data");
    const passPathChecks = `[() { case "$2" in /dev/fd/*) builtin [ "$@";; *) return 0;; esac; };`;

    for (const target of [link, plain]) {
      spawnSync("bash", ["-c", `${passPathChecks} ${fifoPokeShell(`'${target}'`)}`], { timeout: 5_000 });
    }

    expect(fs.readFileSync(victim, "utf8")).toBe("projects:\n");
    expect(fs.readFileSync(plain, "utf8")).toBe("operator-data");
  });

  it("send the delayed timer's poke through the same hardened form", () => {
    // The timer runs detached and unsandboxed, up to two hours later, so it
    // needs the link and descriptor checks as much as any other poker.
    vi.mocked(spawn).mockClear();
    scheduleDelayedPoke("proj-delayed", 60_000);
    const script = String(vi.mocked(spawn).mock.calls[0][1]?.[1]);
    expect(script.endsWith(fifoPokeShell('"$f"'))).toBe(true);
  });

  it("return at once from a shell when nothing reads the FIFO", () => {
    const fifo = pokePath("proj-dead");
    execFileSync("mkfifo", [fifo]);
    // `echo > fifo` blocked here until a reader came, holding the pane.
    expect(shellPoke(fifo).error).toBeUndefined();
  });
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

  it("replaces a symlink planted at the path, even a dangling one", () => {
    const fifo = path.join(dir, "link-poll-signal");
    fs.symlinkSync(path.join(dir, "nowhere"), fifo);
    expect(ensureSignalFifo(fifo)).toBe(true);
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
  });

  it("replaces a non-FIFO file squatting the path", () => {
    const fifo = path.join(dir, "squat-poll-signal");
    fs.writeFileSync(fifo, "stale");
    expect(ensureSignalFifo(fifo)).toBe(true);
    expect(fs.statSync(fifo).isFIFO()).toBe(true);
  });

  it("replaces a directory squatting the path", () => {
    // unlink refuses a directory and mkfifo then fails EEXIST, which this
    // function reports by throwing — so a worker could mkdir the path and
    // stall its project's poller, and its review pipeline, indefinitely.
    const fifo = path.join(dir, "dir-poll-signal");
    fs.mkdirSync(path.join(fifo, "nested"), { recursive: true });
    fs.writeFileSync(path.join(fifo, "nested", "junk"), "x");
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

// Only unsandboxed processes spawn a poller. The spawn lock used to sit in the
// worker-writable sessions dir, where a planted lock naming a live process
// older than it is never reclaimed, so every respawn of that poller threw.
describe("pollerSpawnLockPath", () => {
  it("is not held by a lock planted where it used to live", () => {
    const project = `spawn-lock-${process.pid}`;
    const planted = path.join(SESSIONS_DIR, `${project}-poller.spawn.lock`);
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    // This test process: alive, and started before the lock was written.
    fs.writeFileSync(planted, `${process.pid}:3b241101-e2bb-4255-8caf-4136c566a962`);
    try {
      expect(withFileLock(pollerSpawnLockPath(project), () => "spawned", { deadlineMs: 200 })).toBe("spawned");
      expect(path.dirname(pollerSpawnLockPath(project))).toBe(CONTROL_DIR);
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });
});
