// The edits-unwatched marker lets a worker's PreToolUse Bash hook exit before
// starting node (harness/claude-code.ts). A marker left in place while edits
// are watched would skip the baseline that keeps a read-only command from
// cancelling the review, so these tests pin where it may and may not exist,
// against a real registry on disk.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

vi.mock("../src/dashboard/poller-fifo.js", () => ({
  scheduleDelayedPoke: vi.fn(),
  triggerProjectPoll: vi.fn(),
}));
vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  findWorkerPaneId: vi.fn(() => null),
}));
vi.mock("../src/dashboard/poller-holistic-review.js", () => ({
  evaluateHolisticGate: vi.fn(() => ({ eligible: false })),
  maybeDispatchHolisticReview: vi.fn(),
}));

const home = useTmpHome();

const WT = "/wt/wolf/bold-ash";

async function seed(prState?: string): Promise<string> {
  const { addWorker } = await import("../src/dashboard/registry.js");
  addWorker("wolf", {
    name: "bold-ash", sessionId: "s", task: "", branchName: "bold-ash", worktreePath: WT,
    ...(prState ? { prState: prState as never } : {}),
  });
  const { editsUnwatchedMarkerPath } = await import("../src/dashboard/headless-paths.js");
  return editsUnwatchedMarkerPath(WT);
}

describe("edits-unwatched marker", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it("is created once the worker has no review or merge in flight", async () => {
    const marker = await seed();
    const { syncEditsUnwatchedMarker } = await import("../src/dashboard/poller-state.js");
    syncEditsUnwatchedMarker("wolf", "bold-ash");
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("goes in the same registry write that starts a review", async () => {
    const marker = await seed();
    const { syncEditsUnwatchedMarker, transitionState } = await import("../src/dashboard/poller-state.js");
    syncEditsUnwatchedMarker("wolf", "bold-ash");
    expect(transitionState("wolf", "bold-ash", "reviewing")).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(["reviewing", "merge-pending", "resolving", "ci-fixing"])(
    "is never created, and is removed, while the worker is %s",
    async (state) => {
      const marker = await seed(state);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "");
      const { syncEditsUnwatchedMarker } = await import("../src/dashboard/poller-state.js");
      syncEditsUnwatchedMarker("wolf", "bold-ash");
      expect(fs.existsSync(marker)).toBe(false);
      syncEditsUnwatchedMarker("wolf", "bold-ash");
      expect(fs.existsSync(marker)).toBe(false);
    },
  );

  // The unlocked read can be stale: a review launched by another poll process
  // lands between it and the creation. The creation re-reads under the lock.
  it("is not created when a review starts after the unlocked read", async () => {
    const marker = await seed("reviewing");
    vi.doMock("../src/dashboard/registry.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../src/dashboard/registry.js")>(),
      findWorkerByName: () => ({ name: "bold-ash", sessionId: "s", task: "", worktreePath: WT }),
    }));
    try {
      const { syncEditsUnwatchedMarker } = await import("../src/dashboard/poller-state.js");
      syncEditsUnwatchedMarker("wolf", "bold-ash");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      vi.doUnmock("../src/dashboard/registry.js");
    }
  });

  it("comes back after the merge, and survives the settings sweep", async () => {
    const marker = await seed("merge-pending");
    const { syncEditsUnwatchedMarker, transitionState } = await import("../src/dashboard/poller-state.js");
    expect(transitionState("wolf", "bold-ash", "merged")).toBe(true);
    syncEditsUnwatchedMarker("wolf", "bold-ash");
    expect(fs.existsSync(marker)).toBe(true);
    // Older than the sweep's grace, the way a long-idle worker's marker is,
    // beside a removed worker's marker, which the sweep must take.
    fs.writeFileSync(path.join(home.gardenDir, "config.yml"), "projects: {}\n");
    const orphan = path.join(path.dirname(marker), `${"0".repeat(64)}.unwatched`);
    fs.writeFileSync(orphan, "");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(marker, old, old);
    fs.utimesSync(orphan, old, old);
    const { cleanClaudeSettingsFiles } = await import("../src/dashboard/validate.js");
    cleanClaudeSettingsFiles();
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
  });
});
