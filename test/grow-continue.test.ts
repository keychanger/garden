import { describe, it, expect, vi, beforeEach } from "vitest";

// node:fs is mocked because buildGrowContinuePrompt reads .garden/grow-log.md
// from the worktree path. We simulate three states: file-missing,
// file-empty, file-with-content.
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(),
  SESSIONS_DIR: "/tmp/garden-sessions-test",
}));

vi.mock("../src/dashboard/loop.js", () => ({
  dispatchDelayedLoopContinue: vi.fn(),
  loopAutoContinueAfterMerge: vi.fn(() => true),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  updateWorkerFields: vi.fn(),
}));

import {
  growLoopHooks, growAutoContinueAfterMerge, dispatchDelayedGrowContinue,
  buildGrowContinuePrompt, buildGrowIteration1Seed,
} from "../src/dashboard/grow-continue.js";
import {
  dispatchDelayedLoopContinue, loopAutoContinueAfterMerge,
} from "../src/dashboard/loop.js";
import { findWorkerByName, updateWorkerFields } from "../src/dashboard/registry.js";
import { tryGetProject } from "../src/config.js";
import fs from "node:fs";
import type { WorkerEntry } from "../src/dashboard/registry.js";

function makeGrow(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    name: "tall-fern",
    sessionId: "s1",
    task: "",
    workflow: "grow",
    worktreePath: "/tmp/wt/myproject/tall-fern",
    branchName: "tall-fern",
    baseBranch: "main",
    grow: { seed: "harden auth flow", iteration: 2, maxIterations: 5 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
});

// ─── growLoopHooks ────────────────────────────────────────────────────────

describe("growLoopHooks", () => {
  it("readIteration returns iteration and maxIterations from entry.grow", () => {
    const entry = makeGrow();
    const state = growLoopHooks.readIteration(entry);
    expect(state).toEqual({ iteration: 2, maxIterations: 5 });
  });

  it("readIteration returns null when entry.grow is absent", () => {
    const entry = makeGrow({ grow: undefined });
    expect(growLoopHooks.readIteration(entry)).toBeNull();
  });

  it("readIteration falls back to defaults when fields are absent", () => {
    const entry = makeGrow({
      grow: { seed: "x", iteration: undefined, maxIterations: undefined },
    });
    const state = growLoopHooks.readIteration(entry);
    expect(state).toEqual({ iteration: 0, maxIterations: 5 });
  });

  it("writeIteration deep-merges into entry.grow", () => {
    growLoopHooks.writeIteration("myproject", "tall-fern", 3);
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "tall-fern", { grow: { iteration: 3 } },
    );
  });

  it("setInMemoryIteration mutates the in-memory entry", () => {
    const entry = makeGrow();
    growLoopHooks.setInMemoryIteration(entry, 7);
    expect(entry.grow!.iteration).toBe(7);
  });

  it("setInMemoryIteration is a no-op when entry.grow is absent", () => {
    const entry = makeGrow({ grow: undefined });
    expect(() => growLoopHooks.setInMemoryIteration(entry, 7)).not.toThrow();
    expect(entry.grow).toBeUndefined();
  });

  it("logTag is 'grow'", () => {
    expect(growLoopHooks.logTag).toBe("grow");
  });
});

// ─── buildGrowContinuePrompt ──────────────────────────────────────────────

describe("buildGrowContinuePrompt", () => {
  it("includes the upcoming iteration label (K+1 of M)", () => {
    const entry = makeGrow({ grow: { seed: "X", iteration: 2, maxIterations: 5 } });
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).toContain("Iteration 3 of 5");
  });

  it("inlines the seed verbatim under 'Original task'", () => {
    const entry = makeGrow({
      grow: { seed: "harden the auth flow with edge-case tests", iteration: 0, maxIterations: 5 },
    });
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).toContain("Original task:");
    expect(prompt).toContain("harden the auth flow with edge-case tests");
  });

  it("lists files changed last iteration when populated", () => {
    const entry = makeGrow({
      pendingContinueChangedFiles: ["src/foo.ts", "src/bar.test.ts"],
    });
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).toContain("Files you changed last iteration:");
    expect(prompt).toContain("- src/foo.ts");
    expect(prompt).toContain("- src/bar.test.ts");
  });

  it("truncates the changed-files list at 20 with a tail summary", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    const entry = makeGrow({ pendingContinueChangedFiles: many });
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).toContain("- src/file-0.ts");
    expect(prompt).toContain("- src/file-19.ts");
    expect(prompt).not.toContain("- src/file-20.ts");
    expect(prompt).toContain("(and 5 more)");
  });

  it("omits the changed-files section when empty", () => {
    const entry = makeGrow({ pendingContinueChangedFiles: [] });
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).not.toContain("Files you changed last iteration:");
  });

  it("inlines grow-log.md content when present", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      "iter 1: implemented foo()\niter 2: added happy-path tests",
    );
    const entry = makeGrow();
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).toContain("What you've done so far");
    expect(prompt).toContain("iter 1: implemented foo()");
    expect(prompt).toContain("iter 2: added happy-path tests");
  });

  it("omits the log section when grow-log.md is missing", () => {
    // Default mock: ENOENT
    const entry = makeGrow();
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).not.toContain("What you've done so far");
  });

  it("omits the log section when grow-log.md is empty (whitespace-only)", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("\n\n   \n");
    const entry = makeGrow();
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).not.toContain("What you've done so far");
  });

  it("includes the bias and termination paragraphs", () => {
    const entry = makeGrow();
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).toContain("Bias toward hardening");
    expect(prompt).toContain(".garden-done");
    expect(prompt).toContain(".garden/grow-log.md");
  });

  it("works with a missing entry.grow (defensive: defaults applied)", () => {
    const entry = makeGrow({ grow: undefined });
    const prompt = buildGrowContinuePrompt(entry);
    expect(prompt).toContain("Iteration 1 of 5");
    expect(prompt).not.toContain("Original task:"); // empty seed → section omitted
  });
});

// ─── buildGrowIteration1Seed ──────────────────────────────────────────────

describe("buildGrowIteration1Seed", () => {
  it("labels iteration 1 of N and inlines the seed verbatim", () => {
    const out = buildGrowIteration1Seed("polish the auth module", 5);
    expect(out).toContain("Grow loop, iteration 1 of 5");
    expect(out).toContain("polish the auth module");
  });

  it("references the .garden-done sentinel and grow-log.md", () => {
    const out = buildGrowIteration1Seed("X", 5);
    expect(out).toContain(".garden-done");
    expect(out).toContain(".garden/grow-log.md");
  });

  it("uses the maxIterations argument for both budget mention and pacing line", () => {
    const out = buildGrowIteration1Seed("X", 12);
    expect(out).toContain("iteration 1 of 12");
    expect(out).toContain("up to 12");
  });
});

// ─── dispatchDelayedGrowContinue ──────────────────────────────────────────

describe("dispatchDelayedGrowContinue", () => {
  it("delegates to dispatchDelayedLoopContinue with the grow subcommand", () => {
    dispatchDelayedGrowContinue("/usr/local/bin/garden", "myproject", "tall-fern");
    expect(dispatchDelayedLoopContinue).toHaveBeenCalledWith(
      "/usr/local/bin/garden",
      "myproject",
      "tall-fern",
      "_grow-continue-after-merge",
    );
  });
});

// ─── growAutoContinueAfterMerge ───────────────────────────────────────────

describe("growAutoContinueAfterMerge", () => {
  beforeEach(() => {
    vi.mocked(tryGetProject).mockReturnValue({
      name: "myproject", path: "/repo/myproject",
    });
  });

  it("skips when the worker is missing", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);
    growAutoContinueAfterMerge("myproject", "ghost");
    expect(loopAutoContinueAfterMerge).not.toHaveBeenCalled();
  });

  it("skips when the worker is not on the grow workflow", () => {
    vi.mocked(findWorkerByName).mockReturnValue(makeGrow({ workflow: "default" }));
    growAutoContinueAfterMerge("myproject", "tall-fern");
    expect(loopAutoContinueAfterMerge).not.toHaveBeenCalled();
  });

  it("calls loopAutoContinueAfterMerge with grow hooks and upcoming iteration in workerCommandOpts", () => {
    const entry = makeGrow({
      grow: { seed: "X", iteration: 2, maxIterations: 5 },
    });
    vi.mocked(findWorkerByName).mockReturnValue(entry);
    growAutoContinueAfterMerge("myproject", "tall-fern");
    expect(loopAutoContinueAfterMerge).toHaveBeenCalledWith(
      "myproject",
      "tall-fern",
      growLoopHooks,
      { grow: { iteration: 3, maxIterations: 5 } },
    );
  });

  it("falls back to defaults when entry.grow has no iteration field", () => {
    const entry = makeGrow({ grow: { seed: "X", maxIterations: 5 } });
    vi.mocked(findWorkerByName).mockReturnValue(entry);
    growAutoContinueAfterMerge("myproject", "tall-fern");
    expect(loopAutoContinueAfterMerge).toHaveBeenCalledWith(
      "myproject",
      "tall-fern",
      growLoopHooks,
      { grow: { iteration: 1, maxIterations: 5 } },
    );
  });
});
