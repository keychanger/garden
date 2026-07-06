import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";
import type { LastReviewData, WorkerEntry } from "../src/dashboard/registry.js";

// Mutable holders (hoisted so the vi.mock factories can close over them).
const h = vi.hoisted(() => ({
  isTTY: true,
  resolved: null as { project: string; worker: string; entry: WorkerEntry } | null,
  diffStat: "",
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  get isTTY() { return h.isTTY; },
}));

vi.mock("../src/commands/resolve-worker.js", () => ({
  resolveWorkerArg: vi.fn(() => {
    if (!h.resolved) throw new Error("No worker matches 'x'.");
    return h.resolved;
  }),
}));

vi.mock("../src/dashboard/git.js", () => ({
  getDiffStat: vi.fn(() => h.diffStat),
}));

import { review } from "../src/commands/review.js";
import { output } from "../src/output.js";
import { getDiffStat } from "../src/dashboard/git.js";

function setWorker(lastReview?: LastReviewData, worktreePath: string | undefined = "/tmp/wt"): void {
  h.resolved = {
    project: "garden",
    worker: "bold-ash",
    entry: { name: "bold-ash", sessionId: "s1", task: "", worktreePath, lastReview },
  };
}

const clean: LastReviewData = { verdict: "clean", at: Date.UTC(2026, 0, 1), body: "Looks good.", preReviewSha: "aaaaaaa1", tipSha: "aaaaaaa1" };
const fixed: LastReviewData = { verdict: "fixed", at: Date.UTC(2026, 0, 1), body: "Fixed a null deref.", preReviewSha: "aaaaaaa1", tipSha: "bbbbbbb2" };
const failed: LastReviewData = { verdict: "failed", at: Date.UTC(2026, 0, 1), body: "Could not resolve.", preReviewSha: "aaaaaaa1", tipSha: "aaaaaaa1" };

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

beforeEach(() => {
  h.isTTY = true;
  h.diffStat = "";
  vi.clearAllMocks();
});

describe("garden review", () => {
  it("reports when no review has been recorded", async () => {
    setWorker(undefined);
    const lines = (await captureConsoleLog(() => review(["bold-ash"]))).map(strip);
    expect(lines.some(l => l.includes("No review recorded yet"))).toBe(true);
  });

  it("shows the verdict, a passed checks line, and the body for a clean review", async () => {
    setWorker(clean);
    const lines = (await captureConsoleLog(() => review(["bold-ash"]))).map(strip);
    const text = lines.join("\n");
    expect(text).toContain("verdict   clean");
    expect(text).toContain("checks    passed");
    expect(text).toContain("Looks good.");
    // preReviewSha === tipSha → no diff computed, shown as "none".
    expect(text).toContain("changes during review  none (aaaaaaa..aaaaaaa)");
    expect(getDiffStat).not.toHaveBeenCalled();
  });

  it("shows the reviewer diff stat for a fixed review", async () => {
    h.diffStat = " src/foo.ts | 3 +--\n 1 file changed, 1 insertion(+), 2 deletions(-)";
    setWorker(fixed);
    const lines = (await captureConsoleLog(() => review(["bold-ash"]))).map(strip);
    const text = lines.join("\n");
    expect(text).toContain("verdict   fixed");
    expect(text).toContain("changes during review (aaaaaaa..bbbbbbb)");
    expect(text).toContain("1 file changed");
    expect(getDiffStat).toHaveBeenCalledWith("/tmp/wt", "aaaaaaa1", "bbbbbbb2");
  });

  it("marks checks not passing for a failed review", async () => {
    setWorker(failed);
    const lines = (await captureConsoleLog(() => review(["bold-ash"]))).map(strip);
    expect(lines.join("\n")).toContain("checks    not passing");
  });

  it("does not compute a diff when the worktree is gone", async () => {
    // worktreePath set undefined directly — a defaulted param would swallow it.
    h.resolved = {
      project: "garden", worker: "bold-ash",
      entry: { name: "bold-ash", sessionId: "s1", task: "", worktreePath: undefined, lastReview: fixed },
    };
    await captureConsoleLog(() => review(["bold-ash"]));
    expect(getDiffStat).not.toHaveBeenCalled();
  });

  it("emits JSON when not a TTY", async () => {
    h.isTTY = false;
    h.diffStat = "stat-block";
    setWorker(fixed);
    await review(["bold-ash"]);
    expect(output).toHaveBeenCalledWith({
      project: "garden", worker: "bold-ash", review: fixed, diffStat: "stat-block",
    });
  });

  it("defaults to the focused worker ('.') when no argument is given", async () => {
    const { resolveWorkerArg } = await import("../src/commands/resolve-worker.js");
    setWorker(clean);
    await captureConsoleLog(() => review([]));
    expect(resolveWorkerArg).toHaveBeenCalledWith(".");
  });
});
