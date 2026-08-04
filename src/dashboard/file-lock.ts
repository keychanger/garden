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
// is dead (process crashed without cleanup), the lock is reclaimed. We trust
// PIDs only for liveness; the actual exclusion is provided by O_EXCL, and the
// token prevents an old holder from releasing a replacement lock.
//
// No log dependency: this module is imported by config.ts, and log.ts
// imports SESSIONS_DIR from config.ts. Adding a log import here closes a
// circular import that breaks every test importing config. Callers that
// catch the throw can log themselves with their own context.
import fs from "node:fs";
import path from "node:path";
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A young file with no parsable pid is an acquire caught between its open and
// pid-write, so it is not stale. Once old, only an unparseable record or a
// demonstrably dead holder can be reclaimed.
function lockAppearsStale(filePath: string): boolean {
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return true; // vanished between checks — a reclaim rename will ENOENT harmlessly
  }
  const holderPid = readHolderPid(filePath);
  if (holderPid !== null) return !processIsAlive(holderPid);
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
function reclaimStaleLock(lockPath: string, ownerId: string): boolean {
  const salvage = `${lockPath}.reclaiming.${ownerId}`;
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
  const owner = `${myPid}:${randomUUID()}`;
  const ownerId = owner.slice(owner.indexOf(":") + 1);
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
        if (lockAppearsStale(lockPath) && reclaimStaleLock(lockPath, ownerId)) {
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
