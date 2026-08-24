// Worker git cleanup: removing a worker's worktree, its local branch, and its
// origin branch after the registry entry is gone.
//
// This used to be a detached `sh -c` one-liner whose every step ended in
// `2>/dev/null || true`. That swallowed the one failure mode that matters: the
// removing process cannot always WRITE the project checkout. `garden` run from
// inside an agent's sandbox (a Codex worker's pane, where the writable roots
// are the worker's own worktree plus ~/.garden/sessions) can kill the tmux
// window and delete the registry entry — both land in allowed paths — and then
// silently fail every git step. The worktree and branch leak with no error, no
// log line, and no retry; the only surviving signal is the watchdog's orphan
// sweep an hour later, which can say "nothing owns this" but not "cleanup was
// attempted and denied". That is how leadingtone-io/numb-clear-vow leaked
// 351MB on 2026-08-22.
//
// So cleanup is now a request on disk plus a garden subcommand that executes
// it. The request file IS the marker resurrect and the orphan sweep already
// treat as "cleanup in flight", so their semantics are unchanged; it just
// carries the parameters and the attempt count now. The removing process
// dispatches the fast path immediately (unchanged snappiness when it works),
// and the watchdog — the fleet's one always-unsandboxed recurring process —
// re-dispatches any request still on disk after CLEANUP_RETRY_AFTER_MS. A
// sandboxed caller therefore costs one wasted attempt, not a leaked worktree.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import {
  workerCleanupMarkerPath, branchExistsLocally, gitCleanupStep, gitCleanupOutput,
} from "./git.js";
import { shellEscape } from "./tmux.js";
import { addAlert } from "./alerts.js";
import { log } from "./log.js";

// Filename prefix the watchdog sweep scans for. Kept next to the path builder
// it must agree with (workerCleanupMarkerPath in git.ts) — project and worker
// names both contain hyphens, so the sweep cannot parse identity back out of
// the filename and reads it from the request body instead.
export const CLEANUP_REQUEST_PREFIX = "worker-cleanup-";

// How long a request may sit before the watchdog re-dispatches it. Long enough
// that the fast path (a detached node start plus a worktree rm -rf over a full
// node_modules) has either finished or written its failure back, short enough
// that a denied cleanup is retried in minutes rather than at the next hourly
// housekeeping sweep. A failed attempt rewrites the request, so its mtime
// re-arms this window — the retry cadence is self-throttling.
export const CLEANUP_RETRY_AFTER_MS = 2 * 60_000;

// Attempts before giving up and telling the operator. Two is already enough for
// the motivating case (a sandboxed fast path, then the watchdog's unsandboxed
// retry); the third covers a transient origin failure without turning a
// genuinely stuck repo into an unbounded retry loop.
export const CLEANUP_MAX_ATTEMPTS = 3;

export interface WorkerCleanupRequest {
  project: string;
  worker: string;
  repoPath: string;
  worktreePath?: string;
  branchName?: string;
  // Completed attempts. Incremented only by a run that actually failed.
  attempts: number;
  lastError?: string;
}

export function isWorkerCleanupRequest(v: unknown): v is WorkerCleanupRequest {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.project === "string" && r.project !== ""
    && typeof r.worker === "string" && r.worker !== ""
    && typeof r.repoPath === "string" && r.repoPath !== ""
    && typeof r.attempts === "number";
}

export function writeWorkerCleanupRequest(req: WorkerCleanupRequest): void {
  atomicWriteFile(
    workerCleanupMarkerPath(req.project, req.worker),
    JSON.stringify(req, null, 2),
  );
}

export function readWorkerCleanupRequest(file: string): WorkerCleanupRequest | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return isWorkerCleanupRequest(parsed) ? parsed : null;
  } catch {
    // Absent, unreadable, or a pre-upgrade empty marker written by the old
    // `sh -c` path. Either way there is no request to act on; an empty marker
    // ages out when its own cleanup finishes or the operator removes it.
    return null;
  }
}

export function clearWorkerCleanupRequest(project: string, worker: string): void {
  try {
    fs.rmSync(workerCleanupMarkerPath(project, worker), { force: true });
  } catch { /* already gone, or raced with another run */ }
}

// Requests old enough to re-dispatch. Reads only SESSIONS_DIR — no git, no
// registry — so the sweep's selection is testable on its own.
export function dueCleanupRequests(nowMs: number): WorkerCleanupRequest[] {
  let names: string[];
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const due: WorkerCleanupRequest[] = [];
  for (const name of names) {
    if (!name.startsWith(CLEANUP_REQUEST_PREFIX)) continue;
    const file = path.join(SESSIONS_DIR, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs < CLEANUP_RETRY_AFTER_MS) continue;
    } catch {
      continue;
    }
    const req = readWorkerCleanupRequest(file);
    if (req) due.push(req);
  }
  return due;
}

// Build the detached command that executes one cleanup request. Separate from
// the spawn so the composed argv is testable (and so both dispatch sites — the
// removal tail and the watchdog sweep — provably compose the same thing).
export function buildCleanupCommand(
  gardenRunner: string,
  project: string,
  worker: string,
): string {
  return `${gardenRunner} dashboard _worker-cleanup `
    + `${shellEscape(project)} ${shellEscape(worker)}`;
}

// Fire the cleanup subcommand and return. Detached because a worktree holding a
// full node_modules takes seconds to remove and an origin branch delete is a
// network round trip — neither may block the ⌥x keypress that asked for it, nor
// the watchdog's liveness tick. The child inherits the caller's sandbox, which
// is exactly why a failed run leaves its request on disk for the watchdog.
export function dispatchWorkerCleanup(
  gardenRunner: string,
  project: string,
  worker: string,
): void {
  const cmd = buildCleanupCommand(gardenRunner, project, worker);
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    // The request stays on disk; the watchdog sweep is the retry.
    log.warn("cleanup", "dispatch failed", {
      worker,
      data: { project, error: String(err) },
    });
  }
}

// Execute one cleanup request end to end. Every step is idempotent (each checks
// whether its target still exists) so a retry after a partial success finishes
// the remainder instead of reporting the already-done half as a failure.
export function runWorkerCleanup(project: string, worker: string): void {
  const file = workerCleanupMarkerPath(project, worker);
  const req = readWorkerCleanupRequest(file);
  if (!req) return;

  const failures: string[] = [];
  const { repoPath, worktreePath, branchName } = req;

  if (worktreePath && fs.existsSync(worktreePath)) {
    const err = gitCleanupStep(repoPath, ["worktree", "remove", worktreePath, "--force"]);
    if (err) failures.push(`worktree remove: ${err}`);
  } else if (worktreePath) {
    // The directory is gone but git's admin entry under .git/worktrees may not
    // be — an operator `rm -rf`, or a removal that got half way. Left in place
    // it still claims the branch is checked out, so the `branch -D` below
    // fails and the cleanup can never complete. Prune is repo-wide but only
    // drops entries whose worktree is already missing, so it is safe here.
    const err = gitCleanupStep(repoPath, ["worktree", "prune"]);
    if (err) failures.push(`worktree prune: ${err}`);
  }
  // Order matters: git refuses to delete a branch that is still checked out in
  // a worktree, so a failed worktree removal makes this fail too. Reporting
  // both is correct — they share one cause and one remedy.
  if (branchName && branchExistsLocally(repoPath, branchName)) {
    const err = gitCleanupStep(repoPath, ["branch", "-D", branchName]);
    if (err) failures.push(`branch -D: ${err}`);
  }
  if (branchName && branchExistsOnOriginQuiet(repoPath, branchName)) {
    const err = gitCleanupStep(repoPath, ["push", "origin", "--delete", branchName]);
    if (err) failures.push(`push origin --delete: ${err}`);
  }

  if (failures.length === 0) {
    clearWorkerCleanupRequest(project, worker);
    log.info("cleanup", "removed worktree and branch", {
      worker,
      data: { project, worktree: worktreePath, branch: branchName },
    });
    return;
  }

  const attempts = req.attempts + 1;
  const detail = failures.join("; ");
  if (attempts >= CLEANUP_MAX_ATTEMPTS) {
    // Retire the request so the standing condition is reported by the orphan
    // sweep (which names size and age) rather than by a retry that keeps
    // failing. Leaving the marker would be worse than useless: both resurrect
    // and the orphan sweep read its presence as "cleanup in flight" and would
    // stay quiet about the leak forever.
    clearWorkerCleanupRequest(project, worker);
    const leftovers = [
      worktreePath ? `worktree ${worktreePath}` : null,
      branchName ? `branch ${branchName}` : null,
    ].filter((v): v is string => v !== null);
    addAlert({
      level: "warn",
      source: "cleanup",
      project,
      worker,
      message:
        `Git cleanup for '${worker}' failed ${attempts}x and was given up. `
        + `${leftovers.join(" and ")} may still exist in ${repoPath}. `
        + `Last error: ${detail}. Remove manually: `
        + `git -C ${repoPath} worktree remove --force <path>, `
        + `then git -C ${repoPath} worktree prune.`,
      dedupKey: `cleanup-failed:${project}:${worker}`,
    });
    log.warn("cleanup", "gave up", {
      worker,
      data: { project, attempts, error: detail },
    });
    return;
  }

  writeWorkerCleanupRequest({ ...req, attempts, lastError: detail });
  log.warn("cleanup", "failed, will retry", {
    worker,
    data: { project, attempts, error: detail },
  });
}

// `git ls-remote --heads origin <branch>` with the old script's semantics:
// non-empty output means the branch is on origin. Any failure (offline, no
// remote) reports absent, which skips the delete — the same outcome the old
// `| grep -q .` pipeline produced.
function branchExistsOnOriginQuiet(repoPath: string, branchName: string): boolean {
  const out = gitCleanupOutput(repoPath, ["ls-remote", "--heads", "origin", branchName]);
  return out !== null && out.trim() !== "";
}
