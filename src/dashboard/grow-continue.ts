// Per-iteration context reset for grow loops. Mirrors trellis-continue.ts
// in shape but supplies grow-flavored hooks: reads/writes
// entry.grow.iteration; the continue-prompt builder inlines the operator's
// seed plus the changed-files list.
//
// This file currently ships the dispatch wrapper and a stub
// `growAutoContinueAfterMerge`. The real LoopHooks (with
// `buildGrowContinuePrompt`) and the budget-check responsibility (grow's
// terminal-on-budget is `done`, not `failing`, so the cap fires post-merge —
// not at preflight like trellis) are not yet wired.
import { dispatchDelayedLoopContinue } from "./loop.js";
import { log } from "./log.js";
import { findWorkerByName } from "./registry.js";

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
// subcommand. Currently a stub: validates workflow and logs a warning that
// the cold-respawn mechanics are not yet implemented. The pane stays alive
// without a fresh seed; planting a grow worker via newWorker() at this
// point is intended for state-plumbing tests (which do not exercise
// iter ≥ 2).
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
  log.warn("workers", "grow continue stub fired (cold respawn not yet wired)", {
    worker: workerName, data: { project: projectName },
  });
}
