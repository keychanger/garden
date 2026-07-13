import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// Registers beforeEach/afterEach that point GARDEN_DIR at a fresh tmp HOME and
// vi.resetModules() between tests, so each dynamic import re-resolves the dir.
useTmpHome();

async function importTelemetry() {
  return await import("../src/dashboard/telemetry.js");
}

// Read every event line written to the (single) monthly shard.
function readEvents(telemetryDir: string): Array<Record<string, unknown>> {
  const files = fs.existsSync(telemetryDir)
    ? fs.readdirSync(telemetryDir).filter(f => f.startsWith("events-") && f.endsWith(".jsonl"))
    : [];
  const events: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(telemetryDir, f), "utf-8").trim();
    if (!content) continue;
    for (const line of content.split("\n")) events.push(JSON.parse(line));
  }
  return events;
}

describe("telemetry", () => {
  it("records a worker.created snapshot with v + ts and the join key", async () => {
    const t = await importTelemetry();
    t.recordWorkerCreated("garden", "bold-ash", 1_000, {
      workflow: "default",
      harness: "claude-code",
      provider: null,
      model: "opus",
      ultracode: false,
      crew: "all-claude",
      roles: {
        reviewer: { harness: "codex" },
        resolver: { harness: "claude-code", model: "opus" },
        ciFix: { harness: "claude-code", model: "opus" },
      },
      baseBranch: "main",
      rulesHash: "deadbeefcafe",
      gardenVersion: "test",
    });

    const events = readEvents(t.telemetryDir());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.v).toBe(1);
    expect(typeof e.ts).toBe("string");
    expect(e.event).toBe("worker.created");
    expect(e.project).toBe("garden");
    expect(e.worker).toBe("bold-ash");
    expect(e.workerId).toBe("garden/bold-ash/1000");
    expect(e.harness).toBe("claude-code");
    expect(e.provider).toBeNull();
    expect(e.model).toBe("opus");
    expect(e.crew).toBe("all-claude");
    expect((e.roles as Record<string, unknown>).reviewer).toEqual({ harness: "codex" });
    expect(e.rulesHash).toBe("deadbeefcafe");
  });

  it("records a state transition with from/to/workflow", async () => {
    const t = await importTelemetry();
    t.recordStateTransition("garden", "bold-ash", 1_000, "default", "reviewing", "merge-pending");

    const events = readEvents(t.telemetryDir());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.event).toBe("state");
    expect(e.from).toBe("reviewing");
    expect(e.to).toBe("merge-pending");
    expect(e.workflow).toBe("default");
    expect(e.workerId).toBe("garden/bold-ash/1000");
  });

  it("records a merge with the cumulative ordinal and changed-file count", async () => {
    const t = await importTelemetry();
    t.recordMerge("garden", "bold-ash", 1_000, "default", "done", 3, 7);

    const events = readEvents(t.telemetryDir());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.event).toBe("merge");
    expect(e.terminalState).toBe("done");
    expect(e.mergeCount).toBe(3);
    expect(e.changedFiles).toBe(7);
  });

  it("records a review.verdict with duration and fix magnitude", async () => {
    const t = await importTelemetry();
    t.recordReviewVerdict("garden", "bold-ash", 1_000, "default", {
      verdict: "fixed",
      durationMs: 412_000,
      fixFiles: 2,
      fixInsertions: 11,
      fixDeletions: 3,
      preReviewSha: "aaa",
      tipSha: "bbb",
    });

    const e = readEvents(t.telemetryDir())[0];
    expect(e.event).toBe("review.verdict");
    expect(e.verdict).toBe("fixed");
    expect(e.durationMs).toBe(412_000);
    expect(e.fixFiles).toBe(2);
    expect(e.fixInsertions).toBe(11);
    expect(e.fixDeletions).toBe(3);
    expect(e.workerId).toBe("garden/bold-ash/1000");
  });

  it("records a review.verdict for CLEAN with zero fix magnitude", async () => {
    const t = await importTelemetry();
    t.recordReviewVerdict("garden", "w", 1, "default", {
      verdict: "clean",
      durationMs: 90_000,
      fixFiles: 0,
      fixInsertions: 0,
      fixDeletions: 0,
    });
    const e = readEvents(t.telemetryDir())[0];
    expect(e.verdict).toBe("clean");
    expect(e.fixFiles).toBe(0);
    // Omitted optional SHAs stay absent (undefined dropped by JSON).
    expect(e).not.toHaveProperty("preReviewSha");
  });

  it("omits durationMs when the start stamp was missing", async () => {
    const t = await importTelemetry();
    t.recordReviewVerdict("garden", "w", 1, "default", {
      verdict: "failed",
      fixFiles: 0,
      fixInsertions: 0,
      fixDeletions: 0,
    });
    const e = readEvents(t.telemetryDir())[0];
    expect(e).not.toHaveProperty("durationMs");
  });

  it("records resolve.outcome and cifix.outcome with verification + attempts", async () => {
    const t = await importTelemetry();
    t.recordResolveOutcome("garden", "w", 1, "default", {
      verdict: "done",
      verificationPassed: true,
      attempts: 2,
      durationMs: 30_000,
    });
    t.recordCiFixOutcome("garden", "w", 1, "default", {
      verdict: "failed",
      verificationPassed: false,
      attempts: 3,
    });

    const events = readEvents(t.telemetryDir());
    expect(events.map(e => e.event)).toEqual(["resolve.outcome", "cifix.outcome"]);
    expect(events[0]).toMatchObject({
      verdict: "done", verificationPassed: true, attempts: 2, durationMs: 30_000,
    });
    expect(events[1]).toMatchObject({
      verdict: "failed", verificationPassed: false, attempts: 3,
    });
    expect(events[1]).not.toHaveProperty("durationMs");
  });

  it("appends events rather than overwriting", async () => {
    const t = await importTelemetry();
    t.recordStateTransition("garden", "w", 1, "default", "working", "reviewing");
    t.recordStateTransition("garden", "w", 1, "default", "reviewing", "merge-pending");
    t.recordMerge("garden", "w", 1, "default", "merged", 1, 2);

    const events = readEvents(t.telemetryDir());
    expect(events).toHaveLength(3);
    expect(events.map(e => e.event)).toEqual(["state", "state", "merge"]);
  });

  it("omits undefined role models (JSON drops them, not null)", async () => {
    const t = await importTelemetry();
    t.recordWorkerCreated("garden", "w", 1, {
      workflow: "default",
      harness: "codex",
      provider: null,
      model: null,
      ultracode: false,
      crew: null,
      roles: {
        reviewer: { harness: "codex" }, // no model
        resolver: { harness: "claude-code", model: "opus" },
        ciFix: { harness: "claude-code", model: "opus" },
      },
      gardenVersion: "test",
    });
    const raw = fs.readFileSync(
      path.join(t.telemetryDir(), fs.readdirSync(t.telemetryDir())[0]),
      "utf-8",
    );
    // A model-less role snapshot must serialize WITHOUT a model key (JSON drops
    // undefined), so the reviewer role must appear exactly as {"harness":"codex"}.
    // The substring ends in the closing brace, so a regression that emitted
    // "model":null would render {"harness":"codex","model":null} and fail to match.
    expect(raw).toContain('"reviewer":{"harness":"codex"}');
    const e = readEvents(t.telemetryDir())[0];
    expect((e.roles as { reviewer: Record<string, unknown> }).reviewer).not.toHaveProperty("model");
  });

  it("builds a stable durable workerId across name reuse", async () => {
    const t = await importTelemetry();
    expect(t.telemetryWorkerId("p", "w", 42)).toBe("p/w/42");
    // Missing createdAt falls back to 0 rather than throwing.
    expect(t.telemetryWorkerId("p", "w")).toBe("p/w/0");
  });

  it("hashes rules deterministically and shortly", async () => {
    const t = await importTelemetry();
    const a = t.shortHash("global rules + project rules");
    const b = t.shortHash("global rules + project rules");
    const c = t.shortHash("global rules + project rules (edited)");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(12);
  });

  it("never throws even when the payload is exotic", async () => {
    const t = await importTelemetry();
    // Best-effort contract: recording must not throw on the caller's path.
    expect(() =>
      t.recordStateTransition("p", "w", undefined, "default", "working", "reviewing"),
    ).not.toThrow();
  });
});
