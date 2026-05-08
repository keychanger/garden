// Per-iteration context reset for grow loops. See declarative-singing-graham.md
// for design. Mirrors trellis-continue.ts in shape but supplies grow-flavored
// hooks: reads/writes entry.grow.iteration; the continue-prompt builder
// inlines the operator's seed plus the changed-files list.
//
// Phase 2 (this file) ships the dispatch wrapper and a stub
// `growAutoContinueAfterMerge`. Phase 3 fills in the real LoopHooks (with
// `buildGrowContinuePrompt`) and lifts the budget-check responsibility into
// `maybeAutoContinue` (grow's terminal-on-budget is `done`, not `failing`,
// so the cap fires post-merge — not at preflight like trellis).
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
// subcommand. Phase 2 stub: validates workflow and logs a warning that
// Phase 3 mechanics are pending. The pane stays alive without a fresh
// seed; planting a grow worker via newWorker() in Phase 2 is intended
// for state-plumbing tests (which do not exercise iter ≥ 2).
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
  log.warn("workers", "grow continue stub fired (Phase 3 wires the cold respawn)", {
    worker: workerName, data: { project: projectName },
  });
}
