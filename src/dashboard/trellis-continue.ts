// Per-iteration context reset for trellis vines. See WORKFLOWS.md "Per-iteration
// context reset" — Invariant 8. The deliberate divergence from the default
// workflow's auto-continue: each iteration starts with a fresh Claude
// process, so conversation history does not compound across iterations.
//
// As of the loop-primitive extraction, the heavy lifting (kill claude /
// regen sessionId / respawn-pane / dispatchDelayedSeed) lives in
// `src/dashboard/loop.ts` as `loopAutoContinueAfterMerge`. This module
// supplies the trellis-specific `LoopHooks` (per-iteration field shape on
// `entry.trellis`, `buildTrellisContinuePrompt`) and the workflow guard +
// model resolution that wrap the shared call.
//
// Sequence on a DRIFT-then-merge:
//   1. finalizeMerge synced the worktree to the merged tip.
//   2. dispatchDelayedTrellisContinue fires a detached subprocess that
//      sleeps a few seconds, then invokes `dashboard
//      _trellis-continue-after-merge <project> <worker>`.
//   3. trellisAutoContinueAfterMerge: validates workflow, resolves the
//      iteration's model (Sonnet → Opus fallback or refuse), and hands off
//      to `loopAutoContinueAfterMerge` with the trellis hooks. The shared
//      primitive does the cold respawn and seeds the trellis-shaped
//      continue prompt.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../config.js";
import { trellisRelativePathForEntry } from "./create.js";
import {
  dispatchDelayedLoopContinue, loopAutoContinueAfterMerge,
  type LoopHooks,
} from "./loop.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "./registry.js";
import { resolveAndApplyVineModel } from "./trellis-model.js";
import { getWorkflow } from "./workflows/index.js";

const LESSONS_FILE_REL = path.join(".garden", "trellis-lessons.md");

// Trellis-flavored hooks for the loop primitive. Reads/writes
// entry.trellis.iteration and routes the continue prompt through
// buildTrellisContinuePrompt.
export const trellisLoopHooks: LoopHooks = {
  logTag: "trellis",
  readIteration(entry) {
    if (!entry.trellis) return null;
    return {
      iteration: entry.trellis.iteration ?? 0,
      maxIterations: entry.trellis.maxIterations ?? 30,
    };
  },
  writeIteration(projectName, workerName, next) {
    updateWorkerFields(projectName, workerName, { trellis: { iteration: next } });
  },
  setInMemoryIteration(entry, next) {
    if (entry.trellis) entry.trellis.iteration = next;
  },
  buildContinuePrompt(entry) {
    return buildTrellisContinuePrompt(entry);
  },
};

// Detached subprocess that delays a few seconds, then dispatches the
// fresh-context respawn for a trellis vine. Thin wrapper over the shared
// `dispatchDelayedLoopContinue`.
export function dispatchDelayedTrellisContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  dispatchDelayedLoopContinue(
    gardenRunner, projectName, workerName, "_trellis-continue-after-merge",
  );
}

// Trellis-specific entry point invoked by the
// `_trellis-continue-after-merge` subcommand. Validates workflow + resolves
// model, then hands off to the shared primitive.
export function trellisAutoContinueAfterMerge(
  projectName: string,
  workerName: string,
): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) {
    log.warn("workers", "trellis continue skipped, worker missing", {
      worker: workerName, data: { project: projectName },
    });
    return;
  }
  if (entry.workflow !== "trellis") {
    log.warn("workers", "trellis continue called on non-trellis worker", {
      worker: workerName, data: { project: projectName, workflow: entry.workflow },
    });
    return;
  }
  const project = tryGetProject(projectName);
  if (!project) return;

  // Resolve this iteration's model. May fall back Sonnet → Opus, or refuse
  // outright (Sonnet exhausted + trellisOpusFallback=false). On refusal,
  // the global pause was flipped — skip the respawn entirely. The next
  // iteration fires when Sonnet resets or operator runs `garden auto on`.
  const resolvedModel = resolveAndApplyVineModel(projectName, entry, getWorkflow("trellis"));
  if (resolvedModel === null) {
    log.warn("workers", "trellis continue skipped, vine paused on Sonnet exhaustion", {
      worker: workerName, data: { project: projectName },
    });
    return;
  }

  const trellisRelativePath = trellisRelativePathForEntry(entry, project.path);
  loopAutoContinueAfterMerge(projectName, workerName, trellisLoopHooks, {
    trellisRelativePath,
    model: resolvedModel,
  });
}

// Build the trellis continue prompt for iteration N+1. Reads
// `entry.trellis.iteration + 1` per WORKFLOWS.md (the increment fires inside
// the next launchReview, not here). See "Continue prompt structure".
export function buildTrellisContinuePrompt(entry: WorkerEntry): string {
  const t = entry.trellis;
  const upcomingIter = (t?.iteration ?? 0) + 1;
  const max = t?.maxIterations ?? 30;
  const trellisDisplay = trellisDisplayPath(entry);
  const driftLines = t?.lastDrift ?? [];
  const changed = entry.pendingContinueChangedFiles ?? [];
  const lessons = readLessonsFile(entry.worktreePath);

  const parts: string[] = [];
  parts.push(
    `[garden] Your previous iteration was merged. The trellis at \`${trellisDisplay}\` ` +
    `is your authority — read it before editing.`,
  );
  parts.push(`Iteration ${upcomingIter} of ${max}.`);

  if (changed.length > 0) {
    const list = changed.slice(0, 20).map(f => `  - ${f}`).join("\n");
    const tail = changed.length > 20 ? `\n  - ... (and ${changed.length - 20} more)` : "";
    parts.push(`Files that changed during review:\n${list}${tail}`);
  }

  if (driftLines.length > 0) {
    const list = driftLines.map(line => `  ${line}`).join("\n");
    parts.push(`Drift remaining:\n${list}`);
  } else {
    parts.push(
      "Drift remaining: (none reported by reviewer; if you believe the loop " +
      "is converged, write `.garden-done` at your worktree root before ending " +
      "your turn so the next merge terminates the loop instead of looping.)",
    );
  }

  if (lessons) {
    parts.push(
      `Lessons from previous iterations (\`${LESSONS_FILE_REL}\`):\n` +
      "```\n" + lessons + "\n```",
    );
  }

  parts.push(
    "Address the highest-priority drift item first. You may address others " +
    "in the same iteration if directly related, but do not chase adjacent " +
    "work — the trellis's \"Out of scope\" section bounds you. After your " +
    `changes, append a one-line entry to \`${LESSONS_FILE_REL}\` describing ` +
    "what you tried and what you learned. Commit and push when ready. The " +
    "reviewer will compare your work against the trellis; if all drift is " +
    "resolved, the loop ends.",
  );

  return parts.join("\n\n");
}

// --- Helpers -------------------------------------------------------------

function trellisDisplayPath(entry: WorkerEntry): string {
  const tPath = entry.trellis?.path;
  if (!tPath) return entry.trellis?.name ?? "<trellis>";
  const wt = entry.worktreePath;
  if (wt && tPath.startsWith(wt + path.sep)) {
    return tPath.slice(wt.length + 1);
  }
  return tPath;
}

function readLessonsFile(worktreePath: string | undefined): string | null {
  if (!worktreePath) return null;
  const lessonsPath = path.join(worktreePath, LESSONS_FILE_REL);
  try {
    const content = fs.readFileSync(lessonsPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
