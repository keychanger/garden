// Aggregated status for a plot — the highest-priority worker state across
// all projects in the plot. Drives the icon/color beside each plot name in
// the top bar. Priority: failing-working > failing > asking(-working) > working > done > idle.
//
// `asking-working` is `asking` with other work still running in the plot: the
// same yellow flag, plus the spinner. A question parks one worker, not the
// plot, so the strip keeps saying whether anything else is still moving. It
// is derived after the scan rather than ranked, because it is not a state any
// single worker has.
//
// `failing-working` is the same red failure signal as `failing`, animated: a
// failed worker the operator has prompted back into work. It outranks plain
// `failing` so the strip spins whenever ANY failing worker in the plot is
// mid-turn — and stays static when every failing worker is parked, regardless
// of other workers in the plot being busy. The spinner tracks the failing
// worker, not the plot's general activity.
//
// `working` outranks `done` because operators routinely leave finished
// workers parked in `done` pending a manual verify pass, and the strip
// should surface live activity over that backlog. `merged` is folded into
// `working`: the transient post-merge beat is not an operator-actionable
// signal (see STATUS.md invariant 4). Only `done` — set when the worker
// declared itself finished via `.garden-done` — earns the green checkmark
// on the strip.
import type { PlotConfig } from "../config.js";
import { readRegistry, type WorkerRegistry } from "./registry.js";
import { resolveWorkerStatus } from "../commands/status.js";

export type PlotState = "failing-working" | "failing" | "asking-working" | "asking" | "done" | "working" | "idle";

type WorkerPlotState = Exclude<PlotState, "asking-working">;

const PRIORITY: Record<WorkerPlotState, number> = {
  "failing-working": 5,
  failing: 4,
  asking: 3,
  working: 2,
  done: 1,
  idle: 0,
};

export function resolvePlotStatus(plot: PlotConfig, registry?: WorkerRegistry): PlotState {
  const reg = registry ?? readRegistry();
  let best: WorkerPlotState = "idle";
  let anyWorking = false;
  for (const project of plot.projects) {
    const entries = reg.workers[project];
    if (!entries) continue;
    for (const entry of entries) {
      const ws = resolveWorkerStatus(entry);
      let state: WorkerPlotState;
      switch (ws) {
        // agentStatus is read directly rather than through resolveWorkerStatus,
        // which gives prState priority and so hides the live agent state.
        case "failing": state = entry.agentStatus === "working" ? "failing-working" : "failing"; break;
        case "asking": state = "asking"; break;
        case "done": state = "done"; break;
        case "working":
        case "loading":
        case "reviewing":
        case "merge-pending":
        case "resolving":
        case "ci-fixing":
        case "merged":
          state = "working"; break;
        default:
          state = "idle"; break;
      }
      if (state === "working") anyWorking = true;
      if (PRIORITY[state] > PRIORITY[best]) best = state;
      // Only the top state short-circuits: a plain `failing` must keep scanning
      // in case a later worker is failing AND working, which outranks it.
      if (best === "failing-working") return best;
    }
  }
  return best === "asking" && anyWorking ? "asking-working" : best;
}
