import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure unit tests for resolveVineModel + shouldFireFallbackAlert. The
// side-effecting wrapper resolveAndApplyVineModel is exercised indirectly
// via the integration test (workflow-trellis.real.test.ts), which mocks
// the usage snapshot and asserts alert + state updates.

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  resolveVineModel,
  shouldFireFallbackAlert,
} from "../src/dashboard/trellis-model.js";
import type { ProjectConfig, AutoContinueConfig } from "../src/config.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";
import type { UsageSnapshot } from "../src/dashboard/usage.js";
import type { WorkflowDefinition } from "../src/dashboard/workflows/types.js";

const baseEntry: WorkerEntry = {
  name: "swift-vine",
  sessionId: "s1",
  task: "",
  workflow: "trellis",
};

const baseProject: ProjectConfig = { path: "/tmp/proj" };

const trellisWorkflow: Pick<WorkflowDefinition, "workerModel" | "reviewerModel"> = {
  workerModel: "sonnet",
  reviewerModel: "opus",
};

const baseAutoContinue: AutoContinueConfig = {
  enabled: true,
  usageThreshold: 95,
  resumeAfterReset: false,
};

function snapshot(sonnetPct: number | null, resetsAt = "2026-05-13T00:00:00Z"): UsageSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    data: sonnetPct === null
      ? {}
      : { scoped: [{ label: "Sonnet", pct: sonnetPct, resetsAt }] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveVineModel", () => {
  it("returns sonnet when workflow default is sonnet and Sonnet is below threshold", () => {
    const r = resolveVineModel(
      baseEntry, baseProject, trellisWorkflow as WorkflowDefinition,
      snapshot(50), baseAutoContinue,
    );
    expect(r).toEqual({ model: "sonnet", fellBack: false });
  });

  it("returns opus when entry override is opus, regardless of Sonnet meter", () => {
    const r = resolveVineModel(
      { ...baseEntry, trellis: { name: "t", path: "/tmp/t.md", workerModel: "opus" } }, baseProject,
      trellisWorkflow as WorkflowDefinition,
      snapshot(99), baseAutoContinue,
    );
    expect(r).toEqual({ model: "opus", fellBack: false });
  });

  it("entry override takes precedence over workflow default (sonnet override on opus workflow)", () => {
    const opusWorkflow = { workerModel: "opus" } as WorkflowDefinition;
    const r = resolveVineModel(
      { ...baseEntry, trellis: { name: "t", path: "/tmp/t.md", workerModel: "sonnet" } }, baseProject,
      opusWorkflow,
      snapshot(50), baseAutoContinue,
    );
    expect(r).toEqual({ model: "sonnet", fellBack: false });
  });

  it("falls back to opus when Sonnet is at threshold (default fallback enabled)", () => {
    const r = resolveVineModel(
      baseEntry, baseProject, trellisWorkflow as WorkflowDefinition,
      snapshot(95), baseAutoContinue,
    );
    expect(r.model).toBe("opus");
    expect(r.fellBack).toBe(true);
    expect(r.reason).toMatch(/Sonnet/i);
  });

  it("falls back when Sonnet is above threshold (e.g. 99%)", () => {
    const r = resolveVineModel(
      baseEntry, baseProject, trellisWorkflow as WorkflowDefinition,
      snapshot(99), baseAutoContinue,
    );
    expect(r.model).toBe("opus");
    expect(r.fellBack).toBe(true);
  });

  it("returns null with pausedUntil when trellisOpusFallback is false and Sonnet is exhausted", () => {
    const r = resolveVineModel(
      baseEntry,
      { ...baseProject, trellisOpusFallback: false },
      trellisWorkflow as WorkflowDefinition,
      snapshot(95, "2026-05-20T00:00:00Z"), baseAutoContinue,
    );
    expect(r.model).toBeNull();
    expect(r.fellBack).toBe(false);
    expect(r.pausedUntil).toBe("2026-05-20T00:00:00Z");
    expect(r.reason).toMatch(/pausing/i);
  });

  it("does not fall back when Sonnet meter is missing (no data point)", () => {
    const r = resolveVineModel(
      baseEntry, baseProject, trellisWorkflow as WorkflowDefinition,
      snapshot(null), baseAutoContinue,
    );
    expect(r).toEqual({ model: "sonnet", fellBack: false });
  });

  it("does not fall back when snapshot is null (no usage data fetched yet)", () => {
    const r = resolveVineModel(
      baseEntry, baseProject, trellisWorkflow as WorkflowDefinition,
      null, baseAutoContinue,
    );
    expect(r).toEqual({ model: "sonnet", fellBack: false });
  });

  it("uses the project's usageThreshold via autoContinue.usageThreshold", () => {
    // 80 < 90 < 95 — at threshold 90, 92 should trigger fallback.
    const tighter: AutoContinueConfig = { ...baseAutoContinue, usageThreshold: 90 };
    const r = resolveVineModel(
      baseEntry, baseProject, trellisWorkflow as WorkflowDefinition,
      snapshot(92), tighter,
    );
    expect(r.fellBack).toBe(true);
  });

  it("returns null when no model is requested (no workflow default, no entry override)", () => {
    const noModelWorkflow = {} as WorkflowDefinition;
    const r = resolveVineModel(
      baseEntry, baseProject, noModelWorkflow,
      snapshot(50), baseAutoContinue,
    );
    expect(r.model).toBeNull();
    expect(r.fellBack).toBe(false);
  });
});

describe("shouldFireFallbackAlert", () => {
  it("fires when no prior fallback recorded", () => {
    expect(shouldFireFallbackAlert(baseEntry, snapshot(99))).toBe(true);
  });

  it("does not fire when last fallback is recent (within the same Sonnet window)", () => {
    const recentEntry: WorkerEntry = {
      ...baseEntry,
      trellis: { name: "t", path: "/tmp/t.md", modelFallbackAt: Date.now() - 60_000 }, // 1 min ago
    };
    expect(shouldFireFallbackAlert(recentEntry, snapshot(99))).toBe(false);
  });

  it("fires when last fallback is older than 7 days", () => {
    const oldEntry: WorkerEntry = {
      ...baseEntry,
      trellis: { name: "t", path: "/tmp/t.md", modelFallbackAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
    };
    expect(shouldFireFallbackAlert(oldEntry, snapshot(99))).toBe(true);
  });

  it("fires conservatively when no Sonnet meter present in snapshot", () => {
    const recentEntry: WorkerEntry = {
      ...baseEntry,
      trellis: { name: "t", path: "/tmp/t.md", modelFallbackAt: Date.now() - 60_000 },
    };
    expect(shouldFireFallbackAlert(recentEntry, snapshot(null))).toBe(true);
  });
});
