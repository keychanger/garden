import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

async function importHelper() {
  return await import("../src/dashboard/file-lock.js");
}

describe("withFileLock", () => {
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
  });

  it("creates the parent directory if missing", async () => {
    const { withFileLock } = await importHelper();
    const lockPath = path.join(env.sessionsDir, "deep", "nested", "file.lock");
    let ran = false;
    withFileLock(lockPath, () => { ran = true; });
    expect(ran).toBe(true);
  });
});
