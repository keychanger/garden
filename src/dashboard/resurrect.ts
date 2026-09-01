// Rebuild an accidentally killed worker from its telemetry tombstone.
//
// An opt-x kill hard-deletes the worker's registry entry, worktree, and
// branch — but the agent transcript survives on disk, and the kill path
// tombstones the entire final WorkerEntry into the ledger (worker.removed,
// telemetry.ts). Resurrection is the inverse: pick a tombstone, recreate the
// worktree at its ORIGINAL path (session resume is cwd-keyed — a different
// path would orphan the transcript and dangle every file reference in the
// agent's context), restore the entry with its history counters intact, and
// resume the session in a fresh hidden window.
//
// CLI-bundle only: imported solely by commands/resurrect.ts. Never reachable
// from dist/hook.js.
import fs from "node:fs";
import { tryGetProject, type ProjectConfig } from "../config.js";
import { dashboardExists } from "../session.js";
import { readTelemetryEvents, recordWorkerResurrected } from "./telemetry.js";
import { addWorker, findWorkerByName, type WorkerEntry } from "./registry.js";
import { respawnWorkerWindow } from "./create.js";
import { resolveTranscriptPath } from "./conversation.js";
import {
  branchExistsOnOrigin, commitExists, createWorktree, fetchOrigin,
  isAncestor, localBranchExists, resolveBaseBranch, worktreeExists,
  worktreePath as defaultWorktreePath, workerCleanupMarkerPath,
} from "./git.js";
import { startProjectPoller, projectPollerRunning } from "./poller.js";
import { resolveGardenRunner } from "./runner.js";
import { readDashState } from "./state.js";
import { getPaneSize } from "./tmux.js";
import { log } from "./log.js";

export interface Tombstone {
  project: string;
  worker: string;
  workerId: string;
  killedAt: string; // event ts, ISO
  workflow: string;
  entry: WorkerEntry;
}

// The dead-and-rebuildable set: for each worker lifetime (workerId), the
// latest worker.removed not superseded by a worker.resurrected — the ledger
// is chronological, so a re-killed resurrectee tombstones again and
// reappears. Workers currently alive in the registry are excluded even
// without a resurrected marker (a hand-rebuilt worker has no such event).
// Newest kill first.
export function listTombstones(opts: { project?: string } = {}): Tombstone[] {
  const byWorkerId = new Map<string, Tombstone>();
  for (const e of readTelemetryEvents({ project: opts.project })) {
    if (e.event === "worker.resurrected") {
      byWorkerId.delete(e.workerId);
      continue;
    }
    if (e.event !== "worker.removed") continue;
    const entry = e.entry;
    if (!entry || typeof entry !== "object") continue;
    const we = entry as WorkerEntry;
    if (typeof we.name !== "string" || typeof we.sessionId !== "string") continue;
    byWorkerId.set(e.workerId, {
      project: e.project,
      worker: e.worker,
      workerId: e.workerId,
      killedAt: e.ts,
      workflow: typeof e.workflow === "string" ? e.workflow : "default",
      entry: we,
    });
  }
  return [...byWorkerId.values()]
    .filter(t => !findWorkerByName(t.project, t.worker))
    .sort((a, b) => Date.parse(b.killedAt) - Date.parse(a.killedAt));
}

// Where the dead worker's conversation lives, if it still does. Kills leave
// transcripts untouched, but the agent CLI's own retention eventually reaps
// them — a tombstone without a transcript lists as not resurrectable.
export function tombstoneTranscript(t: Tombstone): string | null {
  return resolveTranscriptPath(t.entry);
}

// Case-insensitive substring match over what the worker WAS (name, branch,
// task) and what it DID (raw transcript text — user prompts and agent output
// both live in the JSONL, and a plain-word query matches JSON-escaped content
// fine). This is the "find the worker that did the schema migration" search;
// precision beyond substring hasn't earned its complexity yet.
export function searchTombstones(tombstones: Tombstone[], query: string): Tombstone[] {
  const q = query.toLowerCase();
  return tombstones.filter(t => {
    if (t.worker.toLowerCase().includes(q)) return true;
    if ((t.entry.task ?? "").toLowerCase().includes(q)) return true;
    if ((t.entry.branchName ?? "").toLowerCase().includes(q)) return true;
    const transcript = tombstoneTranscript(t);
    if (!transcript) return false;
    try {
      return fs.readFileSync(transcript, "utf-8").toLowerCase().includes(q);
    } catch {
      return false;
    }
  });
}

// The rebuilt entry: identity, config, and history counters survive; every
// transient state-machine field is dropped. prState in particular — the kill
// happened at an arbitrary moment, and a resurrected worker must re-enter
// the lifecycle from quiescence (its next Stop re-arms review as usual).
// mergeCount + holisticReviewedThroughMergeCount matter most: without them
// the poller would re-run the holistic pass over already-reviewed scope.
export function rebuildEntry(t: Tombstone, now: number = Date.now()): WorkerEntry {
  const e = t.entry;
  const rebuilt: WorkerEntry = {
    name: e.name,
    sessionId: e.sessionId,
    task: e.task ?? "",
    agentStatus: "idle",
    lastEventAt: now,
    lastStateChangeAt: now,
  };
  if (e.transcriptPath !== undefined) rebuilt.transcriptPath = e.transcriptPath;
  if (e.worktreePath !== undefined) rebuilt.worktreePath = e.worktreePath;
  if (e.branchName !== undefined) rebuilt.branchName = e.branchName;
  if (e.baseBranch !== undefined) rebuilt.baseBranch = e.baseBranch;
  if (e.baseBranchSha !== undefined) rebuilt.baseBranchSha = e.baseBranchSha;
  if (e.createdAt !== undefined) rebuilt.createdAt = e.createdAt;
  if (e.workflow !== undefined) {
    rebuilt.workflow = e.workflow === "botanist" ? "designer" : e.workflow;
  }
  if (e.harness !== undefined) rebuilt.harness = e.harness;
  if (e.provider !== undefined) rebuilt.provider = e.provider;
  if (e.model !== undefined) rebuilt.model = e.model;
  if (e.effort !== undefined) rebuilt.effort = e.effort;
  if (e.ultracode !== undefined) rebuilt.ultracode = e.ultracode;
  if (e.crew !== undefined) rebuilt.crew = e.crew;
  if (e.role !== undefined) rebuilt.role = e.role;
  if (e.failCount !== undefined) rebuilt.failCount = e.failCount;
  if (e.mergeCount !== undefined) rebuilt.mergeCount = e.mergeCount;
  if (e.mergedAt !== undefined) rebuilt.mergedAt = e.mergedAt;
  if (e.holisticReviewedThroughMergeCount !== undefined) {
    rebuilt.holisticReviewedThroughMergeCount = e.holisticReviewedThroughMergeCount;
  }
  if (e.holisticTouchedFiles !== undefined) rebuilt.holisticTouchedFiles = e.holisticTouchedFiles;
  if (e.holisticRationale !== undefined) rebuilt.holisticRationale = e.holisticRationale;
  if (e.lastReview !== undefined) rebuilt.lastReview = e.lastReview;
  if (e.titleGeneratedAt !== undefined) rebuilt.titleGeneratedAt = e.titleGeneratedAt;
  if (e.trellis !== undefined) rebuilt.trellis = e.trellis;
  if (e.grow !== undefined) rebuilt.grow = e.grow;
  return rebuilt;
}

export interface ResurrectOutcome {
  project: string;
  worker: string;
  worktreePath: string;
  branchName: string;
  startedFrom: string;
  resumed: boolean;
  notes: string[];
}

export function resurrectWorker(t: Tombstone): ResurrectOutcome {
  const projectConfig = tryGetProject(t.project);
  if (!projectConfig) {
    throw new Error(`Project '${t.project}' is no longer registered.`);
  }
  if (findWorkerByName(t.project, t.worker)) {
    throw new Error(`Worker ${t.project}/${t.worker} is alive in the registry — nothing to resurrect.`);
  }
  const transcript = tombstoneTranscript(t);
  if (!transcript) {
    throw new Error(
      `Transcript for ${t.project}/${t.worker} (session ${t.entry.sessionId}) is no longer on disk — ` +
      `the conversation is gone, so there is nothing to resume.`,
    );
  }
  if (fs.existsSync(workerCleanupMarkerPath(t.project, t.worker))) {
    throw new Error(
      `Cleanup for ${t.project}/${t.worker} is still running — retry resurrection in a moment.`,
    );
  }

  const notes: string[] = [];
  const wtPath = t.entry.worktreePath ?? defaultWorktreePath(t.project, t.worker);
  const branch = t.entry.branchName ?? t.worker;
  const repoPath = projectConfig.path;

  const startedFrom = worktreeExists(wtPath) || fs.existsSync(wtPath)
    ? recoverExistingWorktree(wtPath, notes)
    : rebuildWorktree(repoPath, wtPath, branch, t.entry, notes);

  const rebuilt = rebuildEntry(t);
  // Point the entry at where things actually are now, in case the tombstone
  // predates a field (legacy entries may lack worktreePath/branchName).
  rebuilt.worktreePath = wtPath;
  rebuilt.branchName = branch;
  if (rebuilt.baseBranch === undefined) rebuilt.baseBranch = resolveBaseBranch(repoPath);
  addWorker(t.project, rebuilt);

  let resumed = false;
  if (dashboardExists()) {
    const state = readDashState();
    const size = state.activePaneId ? getPaneSize(state.activePaneId) : null;
    const windowName = respawnWorkerWindow(t.project, projectConfig, rebuilt, size);
    if (!projectPollerRunning(t.project)) {
      startProjectPoller(t.project, resolveGardenRunner());
    }
    resumed = windowName !== null;
    if (!resumed) {
      notes.push("session was not resumed — check the worker harness/provider configuration");
    }
  } else {
    notes.push("dashboard not running — the session resumes on the next `garden dashboard`");
  }

  recordWorkerResurrected(t.project, t.worker, rebuilt.createdAt, rebuilt.workflow ?? "default");
  log.info("resurrect", "resurrected worker", {
    worker: t.worker,
    data: { project: t.project, branch, startedFrom, resumed },
  });
  return { project: t.project, worker: t.worker, worktreePath: wtPath, branchName: branch, startedFrom, resumed, notes };
}

// The kill's git cleanup runs as a detached background process, so a very
// failed cleanup can leave the worktree on disk. If it is a valid worktree,
// adopt it as-is (best case — even uncommitted files are still there); a bare
// leftover directory without .git blocks `worktree add` and needs the
// operator's eyes, not an rm -rf from us. The live-cleanup marker is checked
// before this point so its detached process cannot delete an adopted tree.
function recoverExistingWorktree(wtPath: string, notes: string[]): string {
  if (worktreeExists(wtPath)) {
    notes.push("worktree was still on disk after kill cleanup — adopted as-is");
    return "existing worktree";
  }
  throw new Error(
    `${wtPath} exists but is not a git worktree. Move it aside, then re-run resurrect.`,
  );
}

// Recreate branch + worktree. Start-point preference:
//   1. the still-existing local branch (kill cleanup raced or failed) — keeps
//      whatever position it had, including unmerged commits;
//   2. the tombstone's last-seen tip SHA, when the commit object still exists
//      and origin/<base> hasn't already absorbed it — restores unmerged work
//      a kill would otherwise have destroyed (deleted branches' commits
//      survive in the object store until gc);
//   3. origin/<base> (the normal case: everything merged before the kill).
function rebuildWorktree(
  repoPath: string,
  wtPath: string,
  branch: string,
  entry: WorkerEntry,
  notes: string[],
): string {
  if (!fetchOrigin(repoPath)) {
    notes.push("git fetch origin failed — rebuilding from local refs");
  }
  if (localBranchExists(repoPath, branch)) {
    createWorktree(repoPath, wtPath, branch, { useExistingBranch: true });
    return `existing local branch ${branch}`;
  }
  const base = entry.baseBranch ?? resolveBaseBranch(repoPath);
  const baseRef = branchExistsOnOrigin(repoPath, base) ? `origin/${base}`
    : localBranchExists(repoPath, base) ? base
    : null;
  const tip = entry.lastSeenSha;
  if (tip && commitExists(repoPath, tip) && (!baseRef || !isAncestor(repoPath, tip, baseRef))) {
    createWorktree(repoPath, wtPath, branch, { startPoint: tip });
    notes.push(`recovered unmerged work: branch restored at ${tip.slice(0, 9)}`);
    return `unmerged tip ${tip.slice(0, 9)}`;
  }
  if (!baseRef) {
    throw new Error(
      `Base branch '${base}' exists neither on origin nor locally in ${repoPath} — cannot rebuild the worktree.`,
    );
  }
  createWorktree(repoPath, wtPath, branch, { startPoint: baseRef });
  return baseRef;
}
