import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// Pass-through by default, so every test that never asks ps runs the real one.
// The pid-reuse tests stand in for it: their answer depends on when this test
// process started, and a worker sandbox denies ps outright.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";

const env = useTmpHome();

// ps -o etime= for any pid: [[dd-]hh:]mm:ss since that process started.
function psReportsElapsed(etime: string): void {
  vi.mocked(spawnSync).mockImplementation(((cmd: string) => {
    if (cmd !== "ps") throw new Error(`unexpected spawn: ${cmd}`);
    return { pid: 0, output: [], stdout: `${etime}\n`, stderr: "", status: 0, signal: null };
  }) as typeof spawnSync);
}

function backdate(file: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

async function importHelper() {
  return await import("../src/dashboard/file-lock.js");
}

describe("withFileLock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // restoreAllMocks leaves a vi.fn's implementation in place.
    vi.mocked(spawnSync).mockReset();
  });

  it("runs fn under the lock and returns its value", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "test.lock");
    const result = withFileLock(lockPath, () => 42);
    expect(result).toBe(42);
    // Lock file is removed after fn completes.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("removes the lock file even if fn throws", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "throw.lock");
    expect(() => withFileLock(lockPath, () => { throw new Error("boom"); })).toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale lock whose holder PID is dead", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "stale.lock");
    // Synthetic stale lockfile with a PID that won't exist.
    fs.writeFileSync(lockPath, "999999999");
    let ran = false;
    withFileLock(lockPath, () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("times out if a live holder keeps the lock", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "contended.lock");
    // The current process IS alive, so the holder check sees a live PID.
    fs.writeFileSync(lockPath, String(process.pid));
    expect(() => withFileLock(lockPath, () => { /* never runs */ }, { deadlineMs: 50 }))
      .toThrow(/Could not acquire/);
    // The synthetic lockfile was not removed by the timeout (only the holder removes it).
    expect(fs.existsSync(lockPath)).toBe(true);
    // Hot locks are contended all the time; a young one is never worth a ps.
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("creates the parent directory if missing", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "deep", "nested", "file.lock");
    let ran = false;
    withFileLock(lockPath, () => { ran = true; });
    expect(ran).toBe(true);
  });

  // The acquire sequence is open(O_CREAT|O_EXCL), writeSync(pid), closeSync(fd).
  // Cross-process, another acquirer can observe the file in the empty window
  // between open and writeSync. parseInt("", 10) is NaN — the dead-holder
  // branch must NOT fire on no-pid-yet content, otherwise it unlinks a live
  // holder's lock and two processes both end up holding it.
  it("does not reclaim a lock whose content has not been written yet", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "midwrite.lock");
    // Empty file = an acquirer that just succeeded openSync(O_CREAT|O_EXCL)
    // but hasn't yet writeSync'd its pid. From a second acquirer's
    // perspective, this is indistinguishable from a stale empty lock.
    fs.writeFileSync(lockPath, "");
    expect(() => withFileLock(lockPath, () => { /* never runs */ }, { deadlineMs: 100 }))
      .toThrow(/Could not acquire/);
    // The synthetic lockfile must NOT have been removed by the recovery
    // branch — only the real holder removes its own lock.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("does not reclaim a lock with garbage (non-numeric) content", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "garbage.lock");
    // A partial write or filesystem corruption could leave non-numeric
    // content. Without a parsable pid we can't prove the holder is dead,
    // and while it is young the safe behavior is to wait, not unlink.
    fs.writeFileSync(lockPath, "not-a-pid");
    expect(() => withFileLock(lockPath, () => { /* never runs */ }, { deadlineMs: 100 }))
      .toThrow(/Could not acquire/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("cleans up the lockfile if stamping the pid fails", async () => {
    // openSync creates the lockfile; if the pid write then fails (ENOSPC, or the
    // holder killed mid-write), leaving the empty file behind would wedge every
    // future writer (parseInt("") is NaN, so no pid check could reclaim it while
    // it is young). The acquire path must remove its own half-made lock.
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "writefail.lock");
    const err = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    vi.spyOn(fs, "writeSync").mockImplementationOnce(() => { throw err; });
    expect(() => withFileLock(lockPath, () => 1)).toThrow("ENOSPC");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims an empty lockfile once it is older than the stale threshold", async () => {
    // The empty-lock wedge: a holder killed between open and pid-write leaves an
    // unparseable lock. The age fallback reclaims it so it is a transient hiccup,
    // not a permanent deadlock.
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "oldempty.lock");
    fs.writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    let ran = false;
    withFileLock(lockPath, () => { ran = true; });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false); // released after fn
  });

  it("does not reclaim an old lock while its holder pid is still live", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "oldlive.lock");
    fs.writeFileSync(lockPath, String(process.pid));
    // However long a holder keeps its lock, it existed when it wrote it. ps
    // counts whole seconds rounded down, so a holder that wrote its lock in its
    // first second can read as having started up to a second after it.
    for (const etime of ["1-00:00:00", "00:59"]) {
      backdate(lockPath, 60_000);
      psReportsElapsed(etime);
      expect(() => withFileLock(lockPath, () => { /* never runs */ }, { deadlineMs: 50 }), etime)
        .toThrow(/Could not acquire/);
      expect(fs.existsSync(lockPath)).toBe(true);
    }
  });

  it("reclaims an old lock whose pid now names a process that started after it", async () => {
    // A holder killed mid-section leaves its lock behind, and once its pid is
    // handed to a later process kill(0) answers for that one. A parsable live
    // holder is never age-evicted, so the lock was held until it exited.
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "reused.lock");
    fs.writeFileSync(lockPath, `${process.pid}:deadbeef-dead-beef-dead-beefdeadbeef`);
    backdate(lockPath, 60 * 60_000);
    psReportsElapsed("05:00");
    expect(withFileLock(lockPath, () => "ran", { deadlineMs: 300 })).toBe("ran");
  });

  it("keeps an old live lock when the holder's start time cannot be read", async () => {
    // ps is denied inside a worker sandbox, and the pid still answers.
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "unreadable-start.lock");
    fs.writeFileSync(lockPath, String(process.pid));
    backdate(lockPath, 60 * 60_000);
    const answer = (fields: object) =>
      (() => ({ pid: 0, output: [], stderr: "", signal: null, ...fields })) as typeof spawnSync;
    for (const ps of [
      answer({ error: Object.assign(new Error("spawnSync ps EPERM"), { code: "EPERM" }), status: null, stdout: "" }),
      answer({ status: 1, stdout: "" }),
      answer({ status: 0, stdout: "not an elapsed time\n" }),
      (() => { throw new Error("spawnSync is not available"); }) as typeof spawnSync,
    ]) {
      vi.mocked(spawnSync).mockImplementation(ps);
      expect(() => withFileLock(lockPath, () => "ran", { deadlineMs: 50 })).toThrow(/Could not acquire/);
      expect(fs.existsSync(lockPath)).toBe(true);
    }
  });

  it("asks ps once per acquire, not on every pass of the wait loop", async () => {
    // The loop re-checks every 5ms; a waiter on a long-held lock would
    // otherwise fork ps on every pass until its deadline.
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "long-held.lock");
    fs.writeFileSync(lockPath, String(process.pid));
    backdate(lockPath, 60_000);
    psReportsElapsed("1-00:00:00");
    expect(() => withFileLock(lockPath, () => "ran", { deadlineMs: 100 })).toThrow(/Could not acquire/);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
  });

  it("reclaims a lock that names pid 1, which no garden holder ever is", async () => {
    // These locks sit in the worker-writable sessions dir, and pid 1 always
    // answers kill(0), so a forged body naming it read as a live holder forever.
    const { withFileLock } = await importHelper();
    for (const body of ["1", "1:deadbeef-dead-beef-dead-beefdeadbeef"]) {
      const lockPath = path.join(env.sessionsDir, "forged.lock");
      fs.writeFileSync(lockPath, body);
      expect(withFileLock(lockPath, () => "ran", { deadlineMs: 300 }), body).toBe("ran");
    }
  });

  it("reclaims a lock naming a pid the OS cannot name", async () => {
    // kill(0) answers a pid past the OS range with a type error rather than
    // ESRCH, so reading every non-ESRCH answer as "alive" let a forged body
    // step around the pid-1 rule by writing a longer number, and a parsable
    // holder is never age-evicted.
    const { withFileLock } = await importHelper();
    for (const body of ["2147483648", "4294967296:deadbeef-dead-beef-dead-beefdeadbeef"]) {
      const lockPath = path.join(env.sessionsDir, "oversized.lock");
      fs.writeFileSync(lockPath, body);
      expect(withFileLock(lockPath, () => "ran", { deadlineMs: 300 }), body).toBe("ran");
    }
  });

  it("waits for a holder the process is not allowed to signal", async () => {
    // EPERM is the one non-ESRCH answer that proves the pid exists: it belongs
    // to another user. Reading it as dead would steal a live holder's lock.
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "foreign.lock");
    const body = "4242:deadbeef-dead-beef-dead-beefdeadbeef";
    fs.writeFileSync(lockPath, body);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    expect(() => withFileLock(lockPath, () => "ran", { deadlineMs: 100 })).toThrow(/Could not acquire/);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(body);
  });

  it("does not remove a replacement lock when releasing", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "replaced.lock");
    const replacementOwner = `${process.pid}:replacement-owner`;

    withFileLock(lockPath, () => {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, replacementOwner);
    });

    expect(fs.readFileSync(lockPath, "utf-8")).toBe(replacementOwner);
  });
});
