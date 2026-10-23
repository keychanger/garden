// Generic O_CREAT|O_EXCL file lock used to serialize read-modify-write cycles
// on shared persistent state (registry, dashboard state, ~/.garden/config.yml).
//
// Why a file lock and not in-process synchronization: the dashboard is a
// federation of short-lived processes (Claude Code hooks, tmux run-shell
// invocations, the long-lived poller, command-line invocations). They all
// share the same on-disk state files. The only mechanism that synchronizes
// across processes without IPC is the filesystem itself.
//
// Each acquisition stamps the holder PID plus a unique owner token. If the PID
// is dead (process crashed without cleanup), or now names a process that
// started after the lock was written, the lock is reclaimed. We trust PIDs only
// for liveness; the actual exclusion is provided by O_EXCL, and the token
// prevents an old holder from releasing a replacement lock.
//
// No log dependency: this module is imported by config.ts, and log.ts
// imports SESSIONS_DIR from config.ts. Adding a log import here closes a
// circular import that breaks every test importing config. Callers that
// catch the throw can log themselves with their own context.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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

// An unowned lock older than this is treated as abandoned. This is the
// backstop for the two shapes the pid check alone can't resolve:
// an empty lockfile left by a holder killed between open and pid-write
// (parseInt("") is NaN, so the liveness probe can't run — without this the lock
// wedges every writer permanently), and a lock whose holder pid was reused by
// an unrelated process after a damaged partial write. A parsable live holder
// is never age-evicted: a slow but legitimate critical section must retain
// exclusion no matter how long it takes.
const STALE_LOCK_MS = 30_000;

function readHolderPid(filePath: string): number | null {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
  const match = /^(\d+)(?::[0-9a-f-]+)?$/i.exec(contents);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  // No garden process is pid 1, which always answers kill(0); a lock naming it
  // is forged (these locks sit in the worker-writable sessions dir) and would
  // otherwise never be reclaimed.
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Only EPERM proves the pid exists: it names another user's process. Every
    // other answer means the OS could not find it — ESRCH for a pid in range,
    // a type error for one past it, which a forged body used to step around
    // the rule above by writing a longer number. A parsable holder is never
    // age-evicted, so reading one of those as alive held the lock forever.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A holder writes its lock after it starts, so a live pid whose process started
// more than STALE_LOCK_MS after the lock was written is not the holder: the
// holder died without releasing and a later process was given its pid. macOS
// hands pids out in sequence below 100,000, so on a machine running a fleet a
// number comes round again within hours, and from then on kill(0) answers for
// whoever has it. A real holder is never reclaimed this way, however long it
// holds, because it existed when it wrote the lock; the margin covers ps's
// whole-second resolution and small clock steps. ps is denied inside a worker
// sandbox, and when it cannot answer the pid's own answer stands.
export function pidStartedAfter(pid: number, sinceMs: number): boolean {
  try {
    const ps = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 1_000,
    });
    // [[dd-]hh:]mm:ss since the process started, or nothing when ps cannot
    // run or cannot see the pid.
    const elapsed = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(ps.stdout ?? "").trim());
    if (!elapsed) return false;
    const [days, hours, minutes, seconds] = elapsed.slice(1).map((v) => Number(v ?? 0));
    return Date.now() - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000 > sinceMs;
  } catch {
    return false;
  }
}

type StartedAfter = (pid: number, sinceMs: number) => boolean;

// A young file with no parsable pid is an acquire caught between its open and
// pid-write, so it is not stale. Once old, only an unparseable record, a
// demonstrably dead holder, or a pid a younger process now has can be
// reclaimed.
function lockAppearsStale(filePath: string, startedAfter: StartedAfter): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return true; // vanished between checks — a reclaim rename will ENOENT harmlessly
  }
  const ageMs = Date.now() - mtimeMs;
  const holderPid = readHolderPid(filePath);
  if (holderPid !== null) {
    if (!processIsAlive(holderPid)) return true;
    return ageMs >= STALE_LOCK_MS && startedAfter(holderPid, mtimeMs + STALE_LOCK_MS);
  }
  return ageMs >= STALE_LOCK_MS;
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
function reclaimStaleLock(lockPath: string, ownerId: string, startedAfter: StartedAfter): boolean {
  const salvage = `${lockPath}.reclaiming.${ownerId}`;
  try {
    fs.renameSync(lockPath, salvage);
  } catch {
    return false; // lost the atomic race (ENOENT) — retry the open
  }
  if (lockAppearsStale(salvage, startedAfter)) {
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
  const owner = `${myPid}:${randomUUID()}`;
  const ownerId = owner.slice(owner.indexOf(":") + 1);
  let acquired = false;
  // The loop re-checks every 5ms, and a pid cannot change hands within one
  // acquire's deadline, so ps is asked at most once per pid and lock.
  const startTimes = new Map<string, boolean>();
  const startedAfter: StartedAfter = (pid, sinceMs) => {
    const key = `${pid}@${sinceMs}`;
    if (!startTimes.has(key)) startTimes.set(key, pidStartedAfter(pid, sinceMs));
    return startTimes.get(key) === true;
  };

  while (!acquired && Date.now() < deadline) {
    let fd: number | null = null;
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      fs.writeSync(fd, owner);
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
        if (lockAppearsStale(lockPath, startedAfter)
            && reclaimStaleLock(lockPath, ownerId, startedAfter)) {
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
    try {
      if (fs.readFileSync(lockPath, "utf-8") === owner) fs.unlinkSync(lockPath);
    } catch { /* ignore */ }
  }
}
