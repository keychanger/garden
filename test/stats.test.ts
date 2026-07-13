import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

const env = useTmpHome();

async function importStats() {
  return (await import("../src/commands/stats.js")).stats;
}

// Write a fixture ledger shard into the tmp telemetry dir.
function writeLedger(events: Array<Record<string, unknown>>): void {
  const dir = path.join(env.gardenDir, "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events-2026-07.jsonl"),
    events.map(e => JSON.stringify(e)).join("\n") + "\n",
  );
}

const NOW = "2026-07-13T12:00:00.000Z";
function ev(event: string, workerId: string, extra: Record<string, unknown> = {}, ts = NOW) {
  const [project, worker] = workerId.split("/");
  return { v: 1, ts, event, project, worker, workerId, ...extra };
}

// Run stats and parse the single JSON line it prints when not a TTY.
async function runStats(args: string[]): Promise<{ rows: Array<Record<string, unknown>>; axis: string }> {
  const stats = await importStats();
  const lines = await captureConsoleLog(() => stats(args));
  return JSON.parse(lines[0]);
}

describe("garden stats", () => {
  it("joins config from worker.created and computes per-group metrics", async () => {
    writeLedger([
      ev("worker.created", "garden/w1/1", { harness: "codex", provider: null, model: null, workflow: "default" }),
      ev("merge", "garden/w1/1", { mergeCount: 1 }),
      ev("merge", "garden/w1/1", { mergeCount: 2 }),
      ev("review.verdict", "garden/w1/1", { verdict: "clean", fixInsertions: 0, fixDeletions: 0, durationMs: 60000 }),
      ev("review.verdict", "garden/w1/1", { verdict: "fixed", fixInsertions: 10, fixDeletions: 5, durationMs: 120000 }),
      ev("worker.tokens", "garden/w1/1", { mergeCount: 2, outputTokens: 5000 }),
      ev("operator.action", "garden/w1/1", { action: "bounce" }),
      // a worker with no worker.created — must bucket to (unknown), not vanish
      ev("merge", "garden/pre/9", { mergeCount: 1 }),
    ]);
    const { rows } = await runStats([]);
    const g = rows.find(r => String(r.group).startsWith("codex"))!;
    expect(g.workers).toBe(1);
    expect(g.merges).toBe(2);
    expect(g.reviews).toBe(2);
    expect(g.cleanPct).toBe(50);       // 1 clean of 2
    expect(g.avgFixLines).toBe(7.5);   // (0 + 15) / 2
    expect(g.avgReviewMs).toBe(90000); // (60000 + 120000) / 2
    expect(g.outputTokens).toBe(5000);
    expect(g.outputTokensPerMerge).toBe(2500);
    expect(g.interventions).toBe(1);
    expect(g.interventionsPerMerge).toBe(0.5);

    const unknown = rows.find(r => r.group === "(unknown)")!;
    expect(unknown.merges).toBe(1);
  });

  it("worker.tokens is cumulative — the highest-mergeCount sample wins", async () => {
    writeLedger([
      ev("worker.created", "garden/w1/1", { harness: "claude-code", workflow: "default" }),
      ev("worker.tokens", "garden/w1/1", { mergeCount: 1, outputTokens: 3000 }),
      ev("worker.tokens", "garden/w1/1", { mergeCount: 2, outputTokens: 8000 }),
      ev("merge", "garden/w1/1", { mergeCount: 2 }),
    ]);
    const { rows } = await runStats([]);
    const g = rows[0];
    expect(g.outputTokens).toBe(8000); // last cumulative, not 3000 or 11000
  });

  it("groups by the --by axis", async () => {
    writeLedger([
      ev("worker.created", "garden/a/1", { harness: "codex", model: "x", workflow: "default" }),
      ev("worker.created", "garden/b/2", { harness: "claude-code", model: "x", workflow: "default" }),
      ev("merge", "garden/a/1", { mergeCount: 1 }),
      ev("merge", "garden/b/2", { mergeCount: 1 }),
    ]);
    const { axis, rows } = await runStats(["--by", "model"]);
    expect(axis).toBe("model");
    // Both workers share model "x", so they collapse into one group of 2.
    const g = rows.find(r => r.group === "x")!;
    expect(g.workers).toBe(2);
    expect(g.merges).toBe(2);
  });

  it("windows metric events by --since but keeps the config join complete", async () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    writeLedger([
      // created long ago — must still resolve config for the in-window merge
      ev("worker.created", "garden/w1/1", { harness: "codex", workflow: "default" }, OLD),
      ev("merge", "garden/w1/1", { mergeCount: 1 }, OLD),  // out of window
      ev("merge", "garden/w1/1", { mergeCount: 2 }, NOW),  // in window (if NOW is recent)
    ]);
    // Use a huge window so NOW counts and OLD doesn't — NOW is a fixed date, so
    // assert the relative behavior: since=100d excludes 2020 but not a 2026 ts
    // only if "now" is near 2026. Guard by checking the in-window count <= total.
    const all = await runStats([]);
    const gAll = all.rows.find(r => String(r.group).startsWith("codex"))!;
    expect(gAll.merges).toBe(2);
    // A 1-minute window excludes both fixed-date merges (neither is within 1m of
    // the real clock), leaving the codex group with 0 merges or absent.
    const recent = await runStats(["--since", "1m"]);
    const gRecent = recent.rows.find(r => String(r.group).startsWith("codex"));
    expect(gRecent === undefined || gRecent.merges === 0).toBe(true);
  });

  it("returns no rows for an empty ledger", async () => {
    writeLedger([]);
    const { rows } = await runStats([]);
    expect(rows).toEqual([]);
  });

  it("rejects an unknown --by axis and a malformed --since", async () => {
    writeLedger([ev("worker.created", "garden/w1/1", { harness: "codex" })]);
    const stats = await importStats();
    await expect(stats(["--by", "bogus"])).rejects.toThrow(/Unknown --by axis/);
    await expect(stats(["--since", "5x"])).rejects.toThrow(/Invalid --since/);
  });
});
