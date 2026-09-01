// Tombstone selection, search, and entry rebuild for `garden resurrect`.
// The git/worktree rebuild rides test/integration/resurrect.real.test.ts;
// this file covers the pure ledger-and-registry logic.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

async function mods() {
  const telemetry = await import("../src/dashboard/telemetry.js");
  const resurrect = await import("../src/dashboard/resurrect.js");
  const registry = await import("../src/dashboard/registry.js");
  return { telemetry, resurrect, registry };
}

function baseEntry(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    sessionId: `session-${name}`,
    task: `task for ${name}`,
    worktreePath: path.join(env.home, ".garden", "worktrees", "proj", name),
    branchName: name,
    baseBranch: "main",
    createdAt: 1_000,
    workflow: "default",
    ...over,
  };
}

describe("listTombstones", () => {
  it("returns the newest kill first and dedupes to the latest per lifetime", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("proj", "old-oak", 1, "default", baseEntry("old-oak"));
    telemetry.recordWorkerRemoved("proj", "new-elm", 2, "default", baseEntry("new-elm"));
    // Same lifetime killed twice (resurrected by hand in between): latest wins.
    telemetry.recordWorkerRemoved("proj", "old-oak", 1, "default", baseEntry("old-oak", { task: "second kill" }));

    const list = resurrect.listTombstones();
    expect(list.map(t => t.worker)).toEqual(["old-oak", "new-elm"]);
    expect(list[0].entry.task).toBe("second kill");
  });

  it("drops a tombstone superseded by worker.resurrected, until a re-kill", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("proj", "oak", 1, "default", baseEntry("oak"));
    telemetry.recordWorkerResurrected("proj", "oak", 1, "default");
    expect((await mods()).resurrect.listTombstones()).toHaveLength(0);

    telemetry.recordWorkerRemoved("proj", "oak", 1, "default", baseEntry("oak", { task: "killed again" }));
    const list = resurrect.listTombstones();
    expect(list).toHaveLength(1);
    expect(list[0].entry.task).toBe("killed again");
  });

  it("excludes workers currently alive in the registry even without a resurrected marker", async () => {
    const { telemetry, resurrect, registry } = await mods();
    telemetry.recordWorkerRemoved("proj", "oak", 1, "default", baseEntry("oak"));
    registry.addWorker("proj", baseEntry("oak") as never);
    expect(resurrect.listTombstones()).toHaveLength(0);
  });

  it("skips tombstones whose entry is missing or unusable", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("proj", "no-session", 1, "default", { name: "no-session" });
    expect(resurrect.listTombstones()).toHaveLength(0);
  });

  it("filters by project", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("proj", "oak", 1, "default", baseEntry("oak"));
    telemetry.recordWorkerRemoved("other", "elm", 1, "default", baseEntry("elm"));
    expect(resurrect.listTombstones({ project: "other" }).map(t => t.worker)).toEqual(["elm"]);
  });
});

describe("searchTombstones", () => {
  it("matches name, task, and branch case-insensitively", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("proj", "shy-cove", 1, "default", baseEntry("shy-cove", { task: "Postgres schema migration" }));
    telemetry.recordWorkerRemoved("proj", "bold-ash", 2, "default", baseEntry("bold-ash", { task: "game design" }));
    const all = resurrect.listTombstones();

    expect(resurrect.searchTombstones(all, "SCHEMA").map(t => t.worker)).toEqual(["shy-cove"]);
    expect(resurrect.searchTombstones(all, "bold").map(t => t.worker)).toEqual(["bold-ash"]);
    expect(resurrect.searchTombstones(all, "nothing")).toHaveLength(0);
  });

  it("matches transcript content — the 'what it did' search", async () => {
    const { telemetry, resurrect } = await mods();
    const transcript = path.join(env.home, "transcript.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "let us federate the wolf tables" } }) + "\n");
    telemetry.recordWorkerRemoved("proj", "shy-cove", 1, "default", baseEntry("shy-cove", { transcriptPath: transcript }));
    const all = resurrect.listTombstones();

    expect(resurrect.searchTombstones(all, "federate").map(t => t.worker)).toEqual(["shy-cove"]);
    expect(resurrect.searchTombstones(all, "kubernetes")).toHaveLength(0);
  });
});

describe("rebuildEntry", () => {
  it("canonicalizes a legacy botanist tombstone before the worker is relaunched", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("proj", "oak", 1, "botanist", baseEntry("oak", {
      workflow: "botanist",
    }));

    const rebuilt = resurrect.rebuildEntry(resurrect.listTombstones()[0]);

    expect(rebuilt.workflow).toBe("designer");
  });

  it("keeps identity, config, and history counters; drops transient state", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("proj", "oak", 1, "default", baseEntry("oak", {
      prState: "done",
      agentStatus: "working",
      harness: "claude-code",
      model: "opus",
      effort: "xhigh",
      crew: "claude-codex",
      mergeCount: 3,
      holisticReviewedThroughMergeCount: 3,
      mergedAt: "2026-07-30T20:49:16.235Z",
      failCount: 1,
      lastReview: { verdict: "fixed", at: 5, body: "ok" },
      titleGeneratedAt: 8,
      // Transients that must not survive the rebuild:
      pendingReviewAt: 123,
      reviewWindowName: "_proj-review-oak",
      reviewStartedAt: 456,
      lastSeenSha: "abc",
      resolveAttempts: 2,
      interruptedWhileWorking: true,
      handoffCallbackExpected: true,
      parentWorker: "gone-parent",
    }));
    const t = resurrect.listTombstones()[0];
    const rebuilt = resurrect.rebuildEntry(t, 99_999);

    expect(rebuilt.name).toBe("oak");
    expect(rebuilt.sessionId).toBe("session-oak");
    expect(rebuilt.agentStatus).toBe("idle");
    expect(rebuilt.prState).toBeUndefined();
    expect(rebuilt.lastEventAt).toBe(99_999);
    expect(rebuilt.lastStateChangeAt).toBe(99_999);
    expect(rebuilt.mergeCount).toBe(3);
    expect(rebuilt.holisticReviewedThroughMergeCount).toBe(3);
    expect(rebuilt.model).toBe("opus");
    expect(rebuilt.effort).toBe("xhigh");
    expect(rebuilt.crew).toBe("claude-codex");
    expect(rebuilt.failCount).toBe(1);
    expect(rebuilt.lastReview).toEqual({ verdict: "fixed", at: 5, body: "ok" });
    expect(rebuilt.titleGeneratedAt).toBe(8);
    expect(rebuilt.createdAt).toBe(1_000);
    expect("pendingReviewAt" in rebuilt).toBe(false);
    expect("reviewWindowName" in rebuilt).toBe(false);
    expect("lastSeenSha" in rebuilt).toBe(false);
    expect("resolveAttempts" in rebuilt).toBe(false);
    expect("interruptedWhileWorking" in rebuilt).toBe(false);
    expect("handoffCallbackExpected" in rebuilt).toBe(false);
    expect("parentWorker" in rebuilt).toBe(false);
  });
});

describe("resurrectWorker preconditions", () => {
  it("refuses when the project is unregistered", async () => {
    const { telemetry, resurrect } = await mods();
    telemetry.recordWorkerRemoved("ghost-proj", "oak", 1, "default", baseEntry("oak"));
    const t = resurrect.listTombstones()[0];
    expect(() => resurrect.resurrectWorker(t)).toThrow(/no longer registered/);
  });

  it("refuses when the transcript is gone — nothing to resume", async () => {
    const { telemetry, resurrect } = await mods();
    fs.mkdirSync(path.join(env.gardenDir), { recursive: true });
    fs.writeFileSync(
      path.join(env.gardenDir, "config.yml"),
      `projects:\n  proj:\n    path: ${path.join(env.home, "repo")}\n`,
    );
    fs.mkdirSync(path.join(env.home, "repo"), { recursive: true });
    telemetry.recordWorkerRemoved("proj", "oak", 1, "default", baseEntry("oak"));
    const t = resurrect.listTombstones()[0];
    expect(() => resurrect.resurrectWorker(t)).toThrow(/no longer on disk/);
  });
});
