// The worker reasoning-effort vocabulary, as a leaf: `node:`-free and
// import-free, so a caller that only needs to validate a rung does not pull in
// create.ts's launch/tmux closure. `garden handoff`'s CLI and the handoff
// dispatcher are both such callers (same split rationale as designer-paths.ts).
//
// These are claude-code's `--effort` levels; the top rung (max effort +
// dynamic workflows) is the ultracode preset, offered in the composer as
// "ultra" and carried by `WorkerEntry.ultracode`, not an effort value here.
// The composer effort submenu and the `--effort` CLI flags build their choices
// from this list plus the "ultra" sentinel.
export const WORKER_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type WorkerEffort = (typeof WORKER_EFFORT_LEVELS)[number];

export function isWorkerEffort(value: string): value is WorkerEffort {
  return (WORKER_EFFORT_LEVELS as readonly string[]).includes(value);
}
