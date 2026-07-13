// Machine-wide semaphore bounding concurrent checks-suite runs. Several
// garden workers (plus reviewers and ci-fix agents) run a project's full
// checks command around the same time when a merge wave lands, and each run
// is a multi-core test suite — overlapping runs oversubscribe the operator's
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

// Claim any free slot in [0, slots). Returns the claimed slot index or null
// when all slots are held by live processes. A slot file with a dead or
// unparseable owner is deleted and immediately contested; losing that race
// to another claimant is fine — the loop just moves on.
export function tryAcquireChecksSlot(slots: number): number | null {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  for (let slot = 0; slot < slots; slot++) {
    const slotFile = checksSlotPath(slot);
    const owner = slotOwner(slotFile);
    if (owner !== null && processAlive(owner)) continue;
    if (fs.existsSync(slotFile)) {
      try {
        fs.unlinkSync(slotFile);
      } catch {
        // A concurrent claimant already removed it.
      }
    }
    try {
      const fd = fs.openSync(
        slotFile,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return slot;
    } catch {
      continue; // lost the create race for this slot; try the next
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
