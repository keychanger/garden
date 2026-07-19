// Machine-wide semaphore bounding concurrent checks-suite runs. Several
// garden workers (plus reviewers) run a project's full checks command around
// the same time when a merge wave lands, and each run is a multi-core test
// suite — overlapping runs oversubscribe the operator's
// workstation into whole-machine sluggishness. The semaphore admits a
// hardware-derived number of runs and queues the rest: clock time stretches,
// the machine stays responsive.
//
// Slots are pid-stamped lock files in SESSIONS_DIR claimed with O_EXCL (the
// same atomic-create election mkfifo provides for pollers). A slot whose
// owning pid is dead is stolen, so a crashed or SIGKILLed run cannot leak its
// slot. Acquisition polls; a bounded max wait fails open (run anyway, warn)
// so a semaphore bug can only ever cost performance, never wedge the fleet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSIONS_DIR } from "./config.js";

// One suite per ~8 cores: a capped vitest pool uses about half a machine's
// cores, so this keeps at least half the hardware free for the interactive
// fleet on small machines while letting big ones run suites side by side.
export function defaultChecksSlots(cores: number = os.availableParallelism()): number {
  return Math.max(1, Math.floor(cores / 8));
}

export function checksSlotPath(slot: number): string {
  return path.join(SESSIONS_DIR, `checks-slot-${slot}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function slotOwner(slotFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(slotFile, "utf8").split("\n")[0] ?? "", 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Atomically steal a slot whose owner is gone. Returns true when the slot was
// freed for reuse. A naive unlink-then-create is racy: two claimants that both
// read the same dead owner both unlink and both O_EXCL-create, and one claimant's
// unlink can delete the other's freshly created file — admitting two holders on
// one slot (the two-holder race dashboard/file-lock.ts documents and this mirrors
// via reclaimStaleLock). renameSync is atomic, so exactly one claimant moves the
// abandoned file to a private salvage name; the losers get ENOENT and fall through
// to retry the create.
//
// But the owner read and the rename are not atomic together: between them another
// claimant can fully reclaim the slot and O_EXCL-create it with a LIVE pid, and our
// rename would then move THAT live holder's file. So re-inspect the salvaged file
// (mirroring reclaimStaleLock): free the slot only if its owner is still dead; if a
// live pid reappeared, restore the file (when the slot is free again, so we never
// clobber a newer holder) and back off rather than admit two holders on one slot.
// Liveness is pid-only, with no age backstop: a checks slot is legitimately held for
// the minutes a suite runs, so evicting on age (as file-lock.ts does for its
// millisecond registry writes) would kill a live holder.
function stealAbandonedSlot(slotFile: string): boolean {
  const owner = slotOwner(slotFile);
  if (owner !== null && processAlive(owner)) return false; // live holder — leave it
  const salvage = `${slotFile}.reclaiming.${process.pid}`;
  try {
    fs.renameSync(slotFile, salvage);
  } catch {
    return false; // lost the atomic steal, or already gone — retry the open
  }
  const salvagedOwner = slotOwner(salvage);
  if (salvagedOwner === null || !processAlive(salvagedOwner)) {
    try { fs.unlinkSync(salvage); } catch { /* already gone */ }
    return true;
  }
  // Renamed away a slot a live holder had reclaimed — restore it best-effort
  // (only if still free) and retry without stealing.
  try {
    if (!fs.existsSync(slotFile)) fs.renameSync(salvage, slotFile);
    else fs.unlinkSync(salvage);
  } catch { /* ignore */ }
  return false;
}

// Claim any free slot in [0, slots). Returns the claimed slot index, or null
// when every slot is held by a live process. A free slot is claimed with an
// atomic O_EXCL create; a slot whose owner has died is stolen atomically (see
// stealAbandonedSlot) and the create retried once. A slot with a live owner, or
// one lost to a concurrent claimant, is skipped.
export function tryAcquireChecksSlot(slots: number): number | null {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  for (let slot = 0; slot < slots; slot++) {
    const slotFile = checksSlotPath(slot);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(
          slotFile,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        );
        fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
        fs.closeSync(fd);
        return slot;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") break; // odd fs error — next slot
        // Occupied. Steal it only if the owner is dead, then retry the create
        // once; a live owner or a lost steal race falls through to the next slot.
        if (attempt === 0 && stealAbandonedSlot(slotFile)) continue;
        break;
      }
    }
  }
  return null;
}

// Release only a slot this process owns — a stale-steal may have handed the
// slot to someone else while we were running, and their claim must survive.
export function releaseChecksSlot(slot: number): void {
  const slotFile = checksSlotPath(slot);
  if (slotOwner(slotFile) === process.pid) {
    try {
      fs.unlinkSync(slotFile);
    } catch {
      // Already gone.
    }
  }
}

export interface AcquireOptions {
  pollMs?: number;
  maxWaitMs?: number;
  /** Called once per poll while waiting, with elapsed wait time. */
  onWait?: (elapsedMs: number) => void;
}

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 45 * 60_000;

// Poll until a slot frees up. Resolves to the slot index, or null when
// maxWaitMs elapses — the caller should proceed ungated (fail open) so a
// leaked slot or pathological queue degrades performance instead of
// deadlocking every checks run on the machine.
export async function acquireChecksSlot(
  slots: number,
  opts: AcquireOptions = {},
): Promise<number | null> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = Date.now();
  for (;;) {
    const slot = tryAcquireChecksSlot(slots);
    if (slot !== null) return slot;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) return null;
    opts.onWait?.(elapsed);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
