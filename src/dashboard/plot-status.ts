// Aggregated status for a plot — the highest-priority worker state across
// all projects in the plot. Drives the icon/color beside each plot name in
// the top bar. Priority: failing > asking > done > working > idle.
//
// `merged` is folded into `working`: the transient post-merge beat is not an
// operator-actionable signal (see STATUS.md invariant 4). Only `done` — set
// when the worker declared itself finished via `.garden-done` — earns the
// green checkmark on the strip.
import type { PlotConfig } from "../config.js";
import { readRegistry, type WorkerRegistry } from "./registry.js";
import { resolveWorkerStatus } from "../commands/status.js";

export type PlotState = "failing" | "asking" | "done" | "working" | "idle";

const PRIORITY: Record<PlotState, number> = {
  failing: 4,
  asking: 3,
  done: 2,
  working: 1,
  idle: 0,
};

export function resolvePlotStatus(plot: PlotConfig, registry?: WorkerRegistry): PlotState {
  const reg = registry ?? readRegistry();
  let best: PlotState = "idle";
  for (const project of plot.projects) {
    const entries = reg.workers[project];
    if (!entries) continue;
    for (const entry of entries) {
      const ws = resolveWorkerStatus(entry);
      let state: PlotState;
      switch (ws) {
        case "failing": state = "failing"; break;
        case "asking": state = "asking"; break;
        case "done": state = "done"; break;
        case "working":
        case "loading":
        case "reviewing":
        case "merge-pending":
        case "resolving":
        case "merged":
          state = "working"; break;
        default:
          state = "idle"; break;
      }
      if (PRIORITY[state] > PRIORITY[best]) best = state;
      if (best === "failing") return best;
    }
  }
  return best;
}
