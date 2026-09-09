import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

// The dashboard repaint is a tmux side effect with nothing to assert; everything
// else (sentinels, registry, alerts) runs against the real temp HOME so the
// interactions between them are exercised rather than described.
vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  setPaneProjectColor: vi.fn(),
}));

const env = useTmpHome();

function makeWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "garden-blocked-"));
}

function seedWorker(overrides: Record<string, unknown> = {}): { worktree: string } {
  const worktree = makeWorktree();
  fs.writeFileSync(
    path.join(env.sessionsDir, "dashboard.registry.json"),
    JSON.stringify({
      workers: {
        proj: [{
          name: "alpha",
          sessionId: "s",
          task: "building the thing",
          worktreePath: worktree,
          ...overrides,
        }],
      },
    }),
  );
  return { worktree };
}

async function readEntry() {
  const { findWorkerByName } = await import("../src/dashboard/registry.js");
  return findWorkerByName("proj", "alpha");
}

async function readAlertMessages(): Promise<string[]> {
  const { readAlerts } = await import("../src/dashboard/alerts.js");
  return readAlerts().alerts.map(a => a.message);
}

describe("blockWorker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the human-gate sentinel, stamps the question, and alerts the operator", async () => {
    const { worktree } = seedWorker();
    const { blockWorker } = await import("../src/dashboard/workers.js");

    const result = blockWorker("proj", "alpha", "Should golden bookmarks be committed?");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(worktree, ".garden-awaiting-input"))).toBe(true);
    expect((await readEntry())?.blockedQuestion).toBe("Should golden bookmarks be committed?");
    expect(await readAlertMessages()).toEqual([
      "alpha is waiting on your decision: Should golden bookmarks be committed?",
    ]);
  });

  // The load-bearing invariant: a worker cannot hold both exits at once, so a
  // blocked worker can never finalize as `done` and can never arm the holistic
  // whole-task review over a task that is not whole.
  it("removes an existing done sentinel so the two exits stay mutually exclusive", async () => {
    const { worktree } = seedWorker();
    fs.writeFileSync(path.join(worktree, ".garden-done"), "");
    const { blockWorker } = await import("../src/dashboard/workers.js");

    blockWorker("proj", "alpha", "Which product shape for evening calls?");

    expect(fs.existsSync(path.join(worktree, ".garden-done"))).toBe(false);
    expect(fs.existsSync(path.join(worktree, ".garden-awaiting-input"))).toBe(true);
  });

  it("rejects an empty question rather than flagging a row with nothing to answer", async () => {
    seedWorker();
    const { blockWorker } = await import("../src/dashboard/workers.js");

    const result = blockWorker("proj", "alpha", "   ");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("A question is required");
    expect((await readEntry())?.blockedQuestion).toBeUndefined();
  });

  it("refuses a worker with no worktree, where the sentinel could not suppress auto-continue", async () => {
    seedWorker({ worktreePath: undefined });
    const { blockWorker } = await import("../src/dashboard/workers.js");

    const result = blockWorker("proj", "alpha", "Ship it?");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no worktreePath");
    expect((await readEntry())?.blockedQuestion).toBeUndefined();
  });

  it("truncates an over-long question so it cannot push the row and alert off-screen", async () => {
    seedWorker();
    const { blockWorker, MAX_BLOCKED_QUESTION_LEN } = await import("../src/dashboard/workers.js");

    blockWorker("proj", "alpha", "q".repeat(MAX_BLOCKED_QUESTION_LEN + 50));

    const stored = (await readEntry())?.blockedQuestion ?? "";
    expect(stored).toHaveLength(MAX_BLOCKED_QUESTION_LEN);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("re-blocking the same worker does not stack duplicate alerts within the dedup window", async () => {
    seedWorker();
    const { blockWorker } = await import("../src/dashboard/workers.js");

    blockWorker("proj", "alpha", "Which shape?");
    blockWorker("proj", "alpha", "Which shape, restated a little differently?");

    expect(await readAlertMessages()).toHaveLength(1);
  });
});

describe("garden blocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GARDEN_WORKER;
    delete process.env.GARDEN_PROJECT;
  });

  it("self-resolves the worker from $GARDEN_WORKER so a pane needs only the question", async () => {
    seedWorker();
    process.env.GARDEN_WORKER = "alpha";
    process.env.GARDEN_PROJECT = "proj";
    const { blocked } = await import("../src/commands/blocked.js");

    const lines = await captureConsoleLog(() => blocked(["Do we commit binary ledgers?"]));

    expect((await readEntry())?.blockedQuestion).toBe("Do we commit binary ledgers?");
    expect(lines.join("\n")).toContain("Blocked alpha");
  });

  // An unquoted question arrives pre-split by the shell. Failing there would
  // fail the worker at exactly the moment it is reporting that it is stuck.
  it("joins a question the shell split into separate arguments", async () => {
    seedWorker();
    process.env.GARDEN_WORKER = "alpha";
    const { blocked } = await import("../src/commands/blocked.js");

    await captureConsoleLog(() => blocked(["Which", "product", "shape?"]));

    expect((await readEntry())?.blockedQuestion).toBe("Which product shape?");
  });

  it("falls back to the shared resolver when $GARDEN_PROJECT is stale", async () => {
    seedWorker();
    process.env.GARDEN_WORKER = "alpha";
    process.env.GARDEN_PROJECT = "renamed-away";
    const { blocked } = await import("../src/commands/blocked.js");

    await captureConsoleLog(() => blocked(["Still reachable?"]));

    expect((await readEntry())?.blockedQuestion).toBe("Still reachable?");
  });

  it("accepts an explicit --worker for out-of-pane use, matching on a prefix", async () => {
    seedWorker();
    const { blocked } = await import("../src/commands/blocked.js");

    await captureConsoleLog(() => blocked(["Ship phase 5?", "--worker", "alp"]));

    expect((await readEntry())?.blockedQuestion).toBe("Ship phase 5?");
  });

  it("requires a question", async () => {
    seedWorker();
    process.env.GARDEN_WORKER = "alpha";
    const { blocked } = await import("../src/commands/blocked.js");

    await expect(blocked([])).rejects.toThrow(/Usage: garden blocked/);
  });

  it("explains itself outside a worker shell instead of guessing a target", async () => {
    seedWorker();
    const { blocked } = await import("../src/commands/blocked.js");

    await expect(blocked(["Who am I?"])).rejects.toThrow(/GARDEN_WORKER not set/);
  });
});

describe("garden resume", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears a block, not just the done sentinel", async () => {
    const { worktree } = seedWorker();
    const { blockWorker } = await import("../src/dashboard/workers.js");
    blockWorker("proj", "alpha", "Which shape?");
    const { resume } = await import("../src/commands/resume.js");

    const lines = await captureConsoleLog(() => resume(["alpha"]));

    expect(fs.existsSync(path.join(worktree, ".garden-awaiting-input"))).toBe(false);
    expect((await readEntry())?.blockedQuestion).toBeUndefined();
    expect(lines.join("\n")).toContain("auto-continue will fire");
  });

  it("still clears the done sentinel on a paused worker", async () => {
    const { worktree } = seedWorker();
    fs.writeFileSync(path.join(worktree, ".garden-done"), "");
    const { resume } = await import("../src/commands/resume.js");

    await captureConsoleLog(() => resume(["alpha"]));

    expect(fs.existsSync(path.join(worktree, ".garden-done"))).toBe(false);
  });

  it("reports a worker that was neither paused nor blocked", async () => {
    seedWorker();
    const { resume } = await import("../src/commands/resume.js");

    const lines = await captureConsoleLog(() => resume(["alpha"]));

    expect(lines.join("\n")).toContain("was not paused or blocked");
  });
});
