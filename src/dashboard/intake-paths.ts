// Bead-intake on-disk stamp paths and their status reader. A deliberate leaf
// (fs/path/config only, like botanist-paths.ts): `garden status` reports
// intake liveness (DELEGATION.md Decision 11) and status.ts is reachable from
// dist/hook.js via header.ts, so these paths cannot live in poller-intake.ts
// — the hook-bundle guard forbids any dashboard/poller-* module there.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";

// Mtime records when the last intake pass started; doubles as the throttle
// anchor (see intakeDue in poller-intake.ts).
export function intakeStampPath(project: string): string {
  return path.join(SESSIONS_DIR, `intake-last-${project}`);
}

// Touched by `garden poke` (and board's gate keys, via the same CLI) so the
// next poller wake runs intake immediately instead of riding the throttle.
export function intakePokePath(project: string): string {
  return path.join(SESSIONS_DIR, `intake-poke-${project}`);
}

// JSON {at, message} written when an intake pass throws; removed by the next
// successful pass. Present = the newest pass failed.
export function intakeErrorPath(project: string): string {
  return path.join(SESSIONS_DIR, `intake-error-${project}`);
}

interface IntakeErrorStamp {
  at: string;
  message: string;
}

function isIntakeErrorStamp(v: unknown): v is IntakeErrorStamp {
  return typeof v === "object" && v !== null
    && typeof (v as IntakeErrorStamp).at === "string"
    && typeof (v as IntakeErrorStamp).message === "string";
}

export function writeIntakeError(project: string, message: string): void {
  const stamp: IntakeErrorStamp = { at: new Date().toISOString(), message };
  try {
    atomicWriteFile(intakeErrorPath(project), JSON.stringify(stamp));
  } catch { /* best-effort; the poller log still carries the error */ }
}

export function clearIntakeError(project: string): void {
  try { fs.unlinkSync(intakeErrorPath(project)); } catch { /* absent */ }
}

export interface IntakeStatus {
  lastIntakeAt?: string;
  lastIntakeError?: string;
}

// The `garden status --json` transport board's dispatch-stalled chip reads:
// when the last intake pass ran (stamp mtime) and the error the newest pass
// caught, if any.
export function readIntakeStatus(project: string): IntakeStatus {
  const out: IntakeStatus = {};
  try {
    out.lastIntakeAt = fs.statSync(intakeStampPath(project)).mtime.toISOString();
  } catch { /* never ran */ }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(intakeErrorPath(project), "utf8"));
    if (isIntakeErrorStamp(parsed)) out.lastIntakeError = parsed.message;
  } catch { /* no error stamp */ }
  return out;
}
