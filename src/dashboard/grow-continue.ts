// Per-iteration context reset for grow loops. Mirrors trellis-continue.ts in
// shape but supplies grow-flavored hooks: reads/writes entry.grow.iteration,
// builds the seed-anchored continue prompt that inlines the operator's seed,
// the changed-files list, and the appended grow-log.
//
// Grow's terminal-on-budget is `done` (not `failing` like trellis): hitting
// the cap means "we did the work we said we'd do", not "we ran out of room".
// The budget check therefore lives in `maybeAutoContinue` (poller-merge.ts),
// not at preflight — by the time iter K = max completes and merges, the loop
// is done; no extra respawn fires.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../config.js";
import {
  dispatchDelayedLoopContinue, loopAutoContinueAfterMerge,
  type LoopHooks,
} from "./loop.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "./registry.js";

const GROW_LOG_FILE_REL = path.join(".garden", "grow-log.md");

// Grow-flavored hooks for the loop primitive. Reads/writes
// entry.grow.iteration and routes the continue prompt through
// buildGrowContinuePrompt.
export const growLoopHooks: LoopHooks = {
  logTag: "grow",
  readIteration(entry) {
    if (!entry.grow) return null;
    return {
      iteration: entry.grow.iteration ?? 0,
      maxIterations: entry.grow.maxIterations ?? 5,
    };
  },
  writeIteration(projectName, workerName, next) {
    updateWorkerFields(projectName, workerName, { grow: { iteration: next } });
  },
  setInMemoryIteration(entry, next) {
    if (entry.grow) entry.grow.iteration = next;
  },
  buildContinuePrompt(entry) {
    return buildGrowContinuePrompt(entry);
  },
};

// Detached subprocess that delays a few seconds, then dispatches the
// fresh-context respawn for a grow worker. Thin wrapper over the shared
// `dispatchDelayedLoopContinue`.
export function dispatchDelayedGrowContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  dispatchDelayedLoopContinue(
    gardenRunner, projectName, workerName, "_grow-continue-after-merge",
  );
}

// Grow-specific entry point invoked by the `_grow-continue-after-merge`
// subcommand. Validates workflow, then hands off to the shared primitive
// with grow-flavored LoopHooks. Each iteration's respawn writes a fresh
// rules file with the upcoming iteration count via the `grow` workerCommand
// option — the worker sees "Iteration K of M" in its system prompt.
export function growAutoContinueAfterMerge(
  projectName: string,
  workerName: string,
): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) {
    log.warn("workers", "grow continue skipped, worker missing", {
      worker: workerName, data: { project: projectName },
    });
    return;
  }
  if (entry.workflow !== "grow") {
    log.warn("workers", "grow continue called on non-grow worker", {
      worker: workerName, data: { project: projectName, workflow: entry.workflow },
    });
    return;
  }
  const project = tryGetProject(projectName);
  if (!project) return;

  // The upcoming iteration index: launchReview will increment to this value
  // before dispatching the next review (preflight semantics, same as
  // trellis). Read it from the entry so the system prompt and the continue
  // prompt agree on the iteration number.
  const upcoming = (entry.grow?.iteration ?? 0) + 1;
  const max = entry.grow?.maxIterations ?? 5;

  loopAutoContinueAfterMerge(projectName, workerName, growLoopHooks, {
    grow: { iteration: upcoming, maxIterations: max },
  });
}

// Build the continue prompt for the upcoming iteration. The seed is
// inlined verbatim so the goal anchors across context resets; the
// changed-files list grounds the worker in the just-merged diff; the
// grow-log content carries cumulative iteration summaries so the worker
// doesn't repeat work.
export function buildGrowContinuePrompt(entry: WorkerEntry): string {
  const g = entry.grow;
  const upcoming = (g?.iteration ?? 0) + 1;
  const max = g?.maxIterations ?? 5;
  const seed = g?.seed ?? "";
  const changed = entry.pendingContinueChangedFiles ?? [];
  const logBody = readGrowLogFile(entry.worktreePath);

  const parts: string[] = [];
  parts.push(`[garden] Your last iteration was merged. Iteration ${upcoming} of ${max} — keep growing this codebase.`);

  if (seed) {
    parts.push(`Original task:\n\n${seed}`);
  }

  if (changed.length > 0) {
    const list = changed.slice(0, 20).map(f => `  - ${f}`).join("\n");
    const tail = changed.length > 20 ? `\n  - ... (and ${changed.length - 20} more)` : "";
    parts.push(`Files you changed last iteration:\n${list}${tail}`);
  }

  if (logBody) {
    parts.push(
      `What you've done so far (\`${GROW_LOG_FILE_REL}\`):\n` +
      "```\n" + logBody + "\n```",
    );
  }

  parts.push(
    "Look for material improvements: edge cases, error handling, missing "
    + "tests, doc updates, security concerns. Bias toward hardening the work "
    + "you've already done — stay in the area of the original task. Do not "
    + "chase adjacent improvements; do not redesign.",
  );

  parts.push(
    "If nothing material remains, write `.garden-done` at your worktree root "
    + "and end your turn — the loop terminates instead of running another "
    + `iteration. Otherwise, make your changes, append a one-line entry to \`${GROW_LOG_FILE_REL}\`, `
    + "commit, and push.",
  );

  return parts.join("\n\n");
}

// Build the iter-1 seed prompt sent at plant time (via seedMessageFile,
// not via auto-continue). The prompt wraps the operator's seed with grow
// framing so the worker paces itself across the bounded loop instead of
// cramming all hardening into iter 1 (where it would be wasted — iter 2
// starts with fresh context anyway). Used by the CLI plant path in
// commands/workers.ts.
export function buildGrowIteration1Seed(seed: string, maxIter: number): string {
  return [
    `[garden] Grow loop, iteration 1 of ${maxIter}.`,
    "",
    `Your task:`,
    "",
    seed,
    "",
    `Iterate to harden recent work in up to ${maxIter} bounded passes. Each pass starts with fresh Claude context. Disk is the only state that crosses iterations: code, tests, docs, and your own notes in \`${GROW_LOG_FILE_REL}\`.`,
    "",
    `Append a one-line entry to \`${GROW_LOG_FILE_REL}\` each iteration describing what you did. When nothing material remains, write \`.garden-done\` at your worktree root before ending your turn so the loop terminates instead of consuming another iteration.`,
  ].join("\n");
}

// --- Helpers -------------------------------------------------------------

function readGrowLogFile(worktreePath: string | undefined): string | null {
  if (!worktreePath) return null;
  const logPath = path.join(worktreePath, GROW_LOG_FILE_REL);
  try {
    const content = fs.readFileSync(logPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
