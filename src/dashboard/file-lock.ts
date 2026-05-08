// Generic O_CREAT|O_EXCL file lock used to serialize read-modify-write cycles
// on shared persistent state (registry, dashboard state, ~/.garden/config.yml).
//
// Why a file lock and not in-process synchronization: the dashboard is a
// federation of short-lived processes (Claude Code hooks, tmux run-shell
// invocations, the long-lived poller, command-line invocations). They all
// share the same on-disk state files. The only mechanism that synchronizes
// across processes without IPC is the filesystem itself.
//
// Stale-lock recovery: if the lockfile exists but the holder PID is dead
// (process crashed without cleanup), the lock is reclaimed. We trust PIDs
// only for liveness; the actual exclusion is provided by O_EXCL.
//
// No log dependency: this module is imported by config.ts, and log.ts
// imports SESSIONS_DIR from config.ts. Adding a log import here closes a
// circular import that breaks every test importing config. Callers that
// catch the throw can log themselves with their own context.
import fs from "node:fs";
import path from "node:path";

export interface FileLockOpts {
  // Total time to wait before giving up. Default 2000ms — tuned to be longer
  // than any realistic write while still well under any human-perceptible
  // pause if a real deadlock occurs.
  deadlineMs?: number;
  // Source tag for the warn log emitted when acquisition fails. Helps the
  // operator tell which lock is contended.
  name?: string;
}

const DEFAULT_DEADLINE_MS = 2000;

export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  opts?: FileLockOpts,
): T {
  const deadline = Date.now() + (opts?.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const myPid = process.pid;
  let acquired = false;

  while (!acquired && Date.now() < deadline) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      fs.writeSync(fd, String(myPid));
      fs.closeSync(fd);
      acquired = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        let holderPid = -1;
        try { holderPid = parseInt(fs.readFileSync(lockPath, "utf-8"), 10); } catch { /* ignore */ }
        const haveValidPid = Number.isFinite(holderPid) && holderPid > 0;
        let holderAlive = false;
        if (haveValidPid) {
          try { process.kill(holderPid, 0); holderAlive = true; } catch { /* dead */ }
        }
        // The acquire sequence is open(O_CREAT|O_EXCL), writeSync(pid),
        // closeSync(fd). A second acquirer can observe the file in the empty
        // window between open and writeSync — parseInt("") is NaN, which is
        // indistinguishable from a stale empty lock at the bit level. Only
        // unlink on positive evidence the holder is dead (parsable pid +
        // signal 0 fails). On no-pid-yet content, wait for the holder to
        // finish writing — otherwise we'd unlink a live holder's lock and
        // both processes would end up holding it.
        if (haveValidPid && !holderAlive) {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, 5);
        continue;
      }
      throw err;
    }
  }

  if (!acquired) {
    throw new Error(`Could not acquire ${opts?.name ?? "file"} lock after ${opts?.deadlineMs ?? DEFAULT_DEADLINE_MS}ms`);
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
