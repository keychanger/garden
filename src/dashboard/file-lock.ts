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

// A lock older than this is treated as abandoned regardless of its pid content.
// This is the backstop for the two shapes the pid check alone can't resolve:
// an empty lockfile left by a holder killed between open and pid-write
// (parseInt("") is NaN, so the liveness probe can't run — without this the lock
// wedges every writer permanently), and a lock whose holder pid was reused by
// an unrelated live process after a reboot (kill 0 sees a live but wrong
// process). Set far above any legitimate hold: registry/state writes take
// milliseconds and the usage poller's longest hold is under its 5s deadline
// (it releases the lock across its network fetch), so a live holder is never
// falsely evicted.
const STALE_LOCK_MS = 30_000;

// Decide whether the lockfile at `filePath` looks abandoned. Stale when the
// pid is parsable and dead, or when the file is older than STALE_LOCK_MS
// regardless of content. A young file with no parsable pid is an acquire caught
// between its open and its pid-write — NOT stale; wait for the holder to finish.
function lockAppearsStale(filePath: string): boolean {
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return true; // vanished between checks — a reclaim rename will ENOENT harmlessly
  }
  if (ageMs >= STALE_LOCK_MS) return true;
  let holderPid = -1;
  try { holderPid = parseInt(fs.readFileSync(filePath, "utf-8"), 10); } catch { /* empty */ }
  if (!(Number.isFinite(holderPid) && holderPid > 0)) return false; // young + no pid: mid-write
  try { process.kill(holderPid, 0); return false; } catch { return true; } // young + dead pid: stale
}

// Atomically clear a lock believed stale. A naive unlinkSync(lockPath) is racy:
// two waiters that both read the same dead pid both unlink, and the second
// unlink can remove a *third* process's freshly created lock, admitting two
// holders (the corroborated two-holder race). Instead we rename the lockfile to
// a private salvage name. rename is atomic, so exactly one racer wins ownership
// of a given inode; losers get ENOENT and just retry the open. The winner then
// re-inspects the salvaged inode it now owns exclusively: if it is genuinely
// stale we discard it; if it turns out live and young (a fresh holder acquired
// between our pre-check and our rename), we hand it back and retry rather than
// run concurrently with that holder. Returns true when the slot was freed.
function reclaimStaleLock(lockPath: string, myPid: number): boolean {
  const salvage = `${lockPath}.reclaiming.${myPid}`;
  try {
    fs.renameSync(lockPath, salvage);
  } catch {
    return false; // lost the atomic race (ENOENT) — retry the open
  }
  if (lockAppearsStale(salvage)) {
    try { fs.unlinkSync(salvage); } catch { /* ignore */ }
    return true;
  }
  // Renamed away a live, recent lock — restore it best-effort (only if the slot
  // is still free, so we never clobber a newer holder) and retry without
  // acquiring. Worst case under a further race is one lost update on a
  // well-formed file (atomicWriteFile keeps it complete), never corruption.
  try {
    if (!fs.existsSync(lockPath)) fs.renameSync(salvage, lockPath);
    else fs.unlinkSync(salvage);
  } catch { /* ignore */ }
  return false;
}

export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  opts?: FileLockOpts,
): T {
  const deadline = Date.now() + (opts?.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const myPid = process.pid;
  let acquired = false;

  while (!acquired && Date.now() < deadline) {
    let fd: number | null = null;
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      fs.writeSync(fd, String(myPid));
      fs.closeSync(fd);
      fd = null;
      acquired = true;
    } catch (err: unknown) {
      if (fd !== null) {
        // We created the lockfile but failed to stamp our pid into it (ENOSPC,
        // or killed mid-write). Leaving it behind orphans an empty lock that no
        // pid check can reclaim — clean up our own mess before rethrowing.
        // Retrying wouldn't fix the underlying write failure.
        try { fs.closeSync(fd); } catch { /* may already be closed */ }
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Cheap pre-check on the live path: only escalate to an atomic reclaim
        // when the lock looks abandoned. A normally-contended lock (a live
        // holder mid-write) just waits — no rename churn on the hot path.
        if (lockAppearsStale(lockPath) && reclaimStaleLock(lockPath, myPid)) {
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
