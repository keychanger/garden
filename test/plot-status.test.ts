import { describe, it, expect } from "vitest";
import { resolvePlotStatus } from "../src/dashboard/plot-status.js";
import type { WorkerRegistry, WorkerEntry } from "../src/dashboard/registry.js";

function reg(workers: Record<string, Partial<WorkerEntry>[]>): WorkerRegistry {
  return {
    workers: Object.fromEntries(
      Object.entries(workers).map(([project, entries]) => [
        project,
        entries.map((e, i) => ({ name: `w${i}`, sessionId: "s", task: "", ...e })),
      ]),
    ),
  } as WorkerRegistry;
}

const plot = { name: "p", projects: ["alpha", "beta"] };

describe("resolvePlotStatus", () => {
  it("reports the highest-priority state across every project in the plot", () => {
    expect(resolvePlotStatus(plot, reg({ alpha: [{ agentStatus: "idle" }] }))).toBe("idle");
    expect(resolvePlotStatus(plot, reg({
      alpha: [{ agentStatus: "idle" }],
      beta: [{ agentStatus: "working" }],
    }))).toBe("working");
    expect(resolvePlotStatus(plot, reg({
      alpha: [{ agentStatus: "working" }],
      beta: [{ prState: "failing" }],
    }))).toBe("failing");
  });

  // The plot strip is what makes a question visible without opening anything —
  // it aggregates across every project in the plot, so one glance at the top bar
  // shows that a worker somewhere is waiting on the operator. This is the reason
  // the blocked exit needs no alert.
  it("flags a plot whose worker recorded a question, over busy siblings", () => {
    expect(resolvePlotStatus(plot, reg({
      alpha: [{ agentStatus: "working" }],
      beta: [{ agentStatus: "idle", prState: "merged", blockedQuestion: "Which shape?" }],
    }))).toBe("asking");
  });

  it("keeps a blocked worker's plot flagged rather than reading its lifecycle state", () => {
    // Without the display derivation this worker is `merged`, which folds into
    // `working` on the strip — busy, not waiting, exactly backwards.
    expect(resolvePlotStatus(plot, reg({
      alpha: [{ agentStatus: "idle", prState: "merged", blockedQuestion: "Which shape?" }],
    }))).toBe("asking");
  });

  it("still lets a failure outrank a question", () => {
    expect(resolvePlotStatus(plot, reg({
      alpha: [{ agentStatus: "idle", prState: "merged", blockedQuestion: "Which shape?" }],
      beta: [{ prState: "failing", agentStatus: "idle" }],
    }))).toBe("failing");
  });

  it("ignores projects outside the plot", () => {
    expect(resolvePlotStatus(plot, reg({
      gamma: [{ agentStatus: "idle", prState: "merged", blockedQuestion: "Which shape?" }],
    }))).toBe("idle");
  });
});
