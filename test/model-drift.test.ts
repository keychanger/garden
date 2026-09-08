import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const workers: Record<string, WorkerEntry[]> = {};
let beforeUpdate: (() => void) | undefined;

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers })),
  updateWorkerFieldsIf: vi.fn((
    project: string,
    workerName: string,
    decide: (entry: WorkerEntry) => { fields: Partial<WorkerEntry> | null; result: unknown },
  ) => {
    beforeUpdate?.();
    beforeUpdate = undefined;
    const entry = workers[project]?.find(candidate => candidate.name === workerName);
    if (!entry) return undefined;
    const decision = decide(entry);
    if (decision.fields !== null) Object.assign(entry, decision.fields);
    return decision.result;
  }),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/alerts.js", () => ({ addAlert: vi.fn() }));

vi.mock("../src/dashboard/tmux.js", () => ({
  shellEscape: vi.fn((value: string) => value),
  pasteAndSubmit: vi.fn(),
  stripControlSequences: vi.fn((value: string) => value),
}));

const { addAlert } = await import("../src/dashboard/alerts.js");
const { sweepWorkerModels } = await import("../src/dashboard/model-drift.js");
const { readCodexRunningModel } = await import("../src/dashboard/harness/codex-core.js");

let dir: string;

// A rollout whose turns ran `models` in order. Padding after each turn_context
// makes the file big enough to exercise the tail/head split when asked.
function rollout(name: string, models: string[], padBytes = 0): string {
  const file = path.join(dir, `${name}.jsonl`);
  const lines: string[] = [
    JSON.stringify({ timestamp: "2026-09-08T19:44:42.585Z", type: "session_meta", payload: { cwd: "/w" } }),
  ];
  for (const model of models) {
    lines.push(JSON.stringify({
      timestamp: "2026-09-08T19:44:42.830Z",
      type: "turn_context",
      payload: { cwd: "/w", model, effort: "high" },
    }));
    if (padBytes > 0) {
      lines.push(JSON.stringify({
        timestamp: "2026-09-08T19:45:00.000Z",
        type: "response_item",
        payload: { type: "reasoning", content: "x".repeat(padBytes) },
      }));
    }
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function worker(fields: Partial<WorkerEntry>): WorkerEntry {
  return {
    name: "cool-swift-hill",
    sessionId: "s",
    task: "t",
    agentStatus: "working",
    harness: "codex",
    ...fields,
  } as WorkerEntry;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-model-drift-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of Object.keys(workers)) delete workers[key];
  beforeUpdate = undefined;
  vi.mocked(addAlert).mockClear();
});

describe("readCodexRunningModel", () => {
  it("reads the model of the NEWEST turn, not the first", () => {
    expect(readCodexRunningModel(rollout("switched", ["gpt-5.6-sol", "gpt-6-astra"])))
      .toBe("gpt-6-astra");
  });

  it("widens the tail to find the newest context on a later long turn", () => {
    // Both contexts sit outside the initial 256KB tail, while the file head
    // contains only the stale first one. The old reader returned Sol here.
    const file = rollout("later-long-turn", ["gpt-5.6-sol", "gpt-6-astra"], 600 * 1024);
    expect(readCodexRunningModel(file, "gpt-5.6-sol")).toBe("gpt-6-astra");
  });

  it("falls back to the head for an unobserved first turn beyond the bounded tail", () => {
    // The motivating shape: a worker still on its FIRST turn, whose only
    // turn_context sits in the preamble far above the bounded tail scan.
    const file = rollout("first-turn", ["gpt-6-astra"], 5 * 1024 * 1024);
    expect(fs.statSync(file).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(readCodexRunningModel(file)).toBe("gpt-6-astra");
  });

  it("does not mistake the first turn for the newest after the bounded tail is exhausted", () => {
    const file = rollout("later-huge-turn", ["gpt-5.6-sol", "gpt-6-astra"], 5 * 1024 * 1024);
    expect(readCodexRunningModel(file, "gpt-5.6-sol")).toBeNull();
  });

  it("answers null for a rollout with no turn_context and for a missing file", () => {
    const file = path.join(dir, "empty.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }) + "\n");
    expect(readCodexRunningModel(file)).toBeNull();
    expect(readCodexRunningModel(path.join(dir, "absent.jsonl"))).toBeNull();
  });

  it("skips a record clipped by the read window instead of failing the whole scan", () => {
    const file = path.join(dir, "clipped.jsonl");
    fs.writeFileSync(file, `{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}\n{"type":"turn_cont`);
    expect(readCodexRunningModel(file)).toBe("gpt-5.6-sol");
  });
});

describe("sweepWorkerModels", () => {
  it("records the running model and alerts when it differs from the pin", () => {
    workers.wolf = [worker({
      model: "gpt-5.6-sol",
      transcriptPath: rollout("drifted", ["gpt-5.6-sol", "gpt-6-astra"]),
    })];

    expect(sweepWorkerModels({ workers } as never)).toBe(1);
    expect(workers.wolf[0].runningModel).toBe("gpt-6-astra");
    // The pin is intent and is never healed to match — a bounce must relaunch
    // on what the operator asked for, not on what the harness substituted.
    expect(workers.wolf[0].model).toBe("gpt-5.6-sol");
    expect(vi.mocked(addAlert)).toHaveBeenCalledOnce();
    const alert = vi.mocked(addAlert).mock.calls[0][0];
    expect(alert.level).toBe("warn");
    expect(alert.message).toContain("gpt-6-astra");
    expect(alert.message).toContain("gpt-5.6-sol");
  });

  it("records a reading that matches the pin without alerting", () => {
    workers.wolf = [worker({
      model: "gpt-5.6-sol",
      transcriptPath: rollout("honored", ["gpt-5.6-sol"]),
    })];

    expect(sweepWorkerModels({ workers } as never)).toBe(1);
    expect(workers.wolf[0].runningModel).toBe("gpt-5.6-sol");
    expect(vi.mocked(addAlert)).not.toHaveBeenCalled();
  });

  it("does not alert an unpinned worker — it has no intent to violate", () => {
    workers.wolf = [worker({ transcriptPath: rollout("unpinned", ["gpt-6-astra"]) })];

    expect(sweepWorkerModels({ workers } as never)).toBe(1);
    expect(workers.wolf[0].runningModel).toBe("gpt-6-astra");
    expect(vi.mocked(addAlert)).not.toHaveBeenCalled();
  });

  it("compares a trellis vine against its own workerModel pin", () => {
    workers.wolf = [worker({
      workflow: "trellis",
      trellis: { name: "auth", iteration: 2, maxIterations: 30, workerModel: "gpt-5.6-sol" },
      transcriptPath: rollout("vine", ["gpt-6-astra"]),
    })];

    sweepWorkerModels({ workers } as never);
    expect(vi.mocked(addAlert)).toHaveBeenCalledOnce();
    expect(vi.mocked(addAlert).mock.calls[0][0].message).toContain("gpt-5.6-sol");
  });

  it("re-sweeps a standing drift without re-writing or re-alerting", () => {
    workers.wolf = [worker({
      model: "gpt-5.6-sol",
      transcriptPath: rollout("standing", ["gpt-6-astra"]),
    })];

    expect(sweepWorkerModels({ workers } as never)).toBe(1);
    vi.mocked(addAlert).mockClear();
    // The alert store dedups too, but the sweep must not depend on that: an
    // unchanged reading is not news and does no work at all.
    expect(sweepWorkerModels({ workers } as never)).toBe(0);
    expect(vi.mocked(addAlert)).not.toHaveBeenCalled();
  });

  it("uses a pin changed concurrently with the sweep", () => {
    const live = worker({
      model: "gpt-5.6-sol",
      transcriptPath: rollout("concurrent-pin", ["gpt-6-astra"]),
    });
    workers.wolf = [live];
    const snapshot = { workers: { wolf: [{ ...live }] } };
    beforeUpdate = () => { live.model = "gpt-6-astra"; };

    expect(sweepWorkerModels(snapshot as never)).toBe(1);
    expect(live.runningModel).toBe("gpt-6-astra");
    expect(vi.mocked(addAlert)).not.toHaveBeenCalled();
  });

  it("does not record a reading after the worker exits during the sweep", () => {
    const live = worker({
      model: "gpt-5.6-sol",
      transcriptPath: rollout("exited-during-read", ["gpt-6-astra"]),
    });
    workers.wolf = [live];
    beforeUpdate = () => { live.agentStatus = "exited"; };

    expect(sweepWorkerModels({ workers } as never)).toBe(0);
    expect(live.runningModel).toBeUndefined();
    expect(vi.mocked(addAlert)).not.toHaveBeenCalled();
  });

  it("skips a worker whose pane is gone", () => {
    workers.wolf = [worker({
      agentStatus: "exited",
      model: "gpt-5.6-sol",
      transcriptPath: rollout("dead", ["gpt-6-astra"]),
    })];

    expect(sweepWorkerModels({ workers } as never)).toBe(0);
    expect(workers.wolf[0].runningModel).toBeUndefined();
  });

  it("leaves a claude-code worker alone — its pin is an alias its transcript never echoes", () => {
    workers.garden = [worker({
      harness: "claude-code",
      model: "opus",
      transcriptPath: rollout("claude", ["gpt-6-astra"]),
    })];

    expect(sweepWorkerModels({ workers } as never)).toBe(0);
    expect(workers.garden[0].runningModel).toBeUndefined();
    expect(vi.mocked(addAlert)).not.toHaveBeenCalled();
  });
});
