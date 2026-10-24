// What an interrupted write leaves behind, and the watchdog's hourly sweep of
// it. A process killed between atomicWriteFile's temp write and its rename
// leaves `<file>.<uuid>.tmp`, and one killed inside a lock reclaim leaves
// `<lock>.reclaiming.<uuid>`. Nothing else removes either: three intake-stamp
// temps sat in the sessions dir for weeks, each from a poller a rebuild killed
// mid-write. The name shapes live beside the code that writes them
// (isAtomicWriteTemp, isLockSalvage).
import fs from "node:fs";
import path from "node:path";
import { CONTROL_DIR, SESSIONS_DIR } from "../paths.js";
import { isAtomicWriteTemp } from "./atomic-write.js";
import { isLockSalvage } from "./file-lock.js";
import { log } from "./log.js";

// A leftover older than this was abandoned: atomicWriteFile renames its temp
// within milliseconds of writing it, and a lock reclaim unlinks or restores its
// salvage as soon as it has re-read it.
export const WRITE_LEFTOVER_MAX_AGE_MS = 60 * 60_000;

// Cap on entries visited in each tree, so a flooded directory cannot stall the
// watchdog's liveness tick (absorbSleep reads an overrun as machine-suspend time).
export const WRITE_LEFTOVER_WALK_CAP = 50_000;

// Only those two name shapes, only regular files, and only past the age above.
// The control tree is walked whole and the sessions dir at its top level only:
// a worker can write the sessions dir, and could swap a subdirectory there for
// a link between the listing and the unlink. Returns the count removed.
export function sweepWriteLeftovers(nowMs: number): number {
  let removed = 0;
  for (const [root, recurse] of [[SESSIONS_DIR, false], [CONTROL_DIR, true]] as const) {
    let visited = 0;
    const stack = [root];
    while (stack.length > 0 && visited < WRITE_LEFTOVER_WALK_CAP) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // absent, unreadable, or removed mid-walk
      }
      for (const entry of entries) {
        if (++visited > WRITE_LEFTOVER_WALK_CAP) break;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recurse) stack.push(file);
          continue;
        }
        if (!entry.isFile() || !(isAtomicWriteTemp(entry.name) || isLockSalvage(entry.name))) continue;
        try {
          if (nowMs - fs.lstatSync(file).mtimeMs <= WRITE_LEFTOVER_MAX_AGE_MS) continue;
          fs.unlinkSync(file);
          removed++;
        } catch { /* raced with its writer or another sweep */ }
      }
    }
  }
  if (removed > 0) {
    log.info("watchdog", "swept abandoned write leftovers", { data: { removed } });
  }
  return removed;
}
