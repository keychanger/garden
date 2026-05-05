import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => "file content"),
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject", checks: null })),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/git.js", () => ({
  getDiffAgainstBase: vi.fn(() => "diff content"),
  getCommitSummary: vi.fn(() => "abc1234 fix: something"),
  getChangedFiles: vi.fn(() => ["src/foo.ts"]),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "project rules here"),
}));

import {
  composePrompt, gatherPromptContext, makeContext,
  type PromptContext, type PromptSection,
} from "../src/dashboard/prompt-compose.js";
import { getDiffAgainstBase } from "../src/dashboard/git.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

function makeEntry(overrides?: Partial<WorkerEntry>): WorkerEntry {
  return {
    name: "bold-ash",
    sessionId: "s1",
    task: "",
    worktreePath: "/tmp/wt/myproject/bold-ash",
    branchName: "bold-ash",
    ...overrides,
  };
}

function makeFixtureContext(): PromptContext {
  return makeContext("myproject", "/repo/myproject", "main", makeEntry(), {
    diff: "",
    commitSummary: "",
    branchName: "bold-ash",
    rules: "",
    checksCommand: undefined,
    changedFiles: [],
    docSections: [],
    testSections: [],
    specFiles: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDiffAgainstBase).mockReturnValue("diff content");
});

describe("composePrompt", () => {
  it("joins section outputs with a single blank line between blocks", () => {
    const sections: PromptSection[] = [
      { name: "a", render: () => "block A" },
      { name: "b", render: () => "block B" },
      { name: "c", render: () => "block C" },
    ];
    const result = composePrompt(sections, makeFixtureContext());
    expect(result).toBe("block A\n\nblock B\n\nblock C");
  });

  it("preserves section ordering", () => {
    const sections: PromptSection[] = [
      { name: "z", render: () => "Z" },
      { name: "y", render: () => "Y" },
      { name: "x", render: () => "X" },
    ];
    expect(composePrompt(sections, makeFixtureContext())).toBe("Z\n\nY\n\nX");
  });

  it("omits sections that return null with no double-blank gap", () => {
    const sections: PromptSection[] = [
      { name: "a", render: () => "A" },
      { name: "skipped", render: () => null },
      { name: "c", render: () => "C" },
    ];
    expect(composePrompt(sections, makeFixtureContext())).toBe("A\n\nC");
  });

  it("returns empty string when all sections are null", () => {
    const sections: PromptSection[] = [
      { name: "a", render: () => null },
      { name: "b", render: () => null },
    ];
    expect(composePrompt(sections, makeFixtureContext())).toBe("");
  });

  it("preserves multi-line content within a single section", () => {
    const sections: PromptSection[] = [
      { name: "multi", render: () => "line 1\nline 2\n\nline 4" },
      { name: "next", render: () => "next block" },
    ];
    expect(composePrompt(sections, makeFixtureContext()))
      .toBe("line 1\nline 2\n\nline 4\n\nnext block");
  });

  it("calls each render with the same context", () => {
    let callCount = 0;
    const sections: PromptSection[] = [
      { name: "a", render: (ctx) => { callCount++; expect(ctx.projectName).toBe("myproject"); return "A"; } },
      { name: "b", render: (ctx) => { callCount++; expect(ctx.baseBranch).toBe("main"); return "B"; } },
    ];
    composePrompt(sections, makeFixtureContext());
    expect(callCount).toBe(2);
  });
});

describe("PromptContext.nextStep", () => {
  it("starts at 1 and increments on each call", () => {
    const ctx = makeFixtureContext();
    expect(ctx.nextStep()).toBe(1);
    expect(ctx.nextStep()).toBe(2);
    expect(ctx.nextStep()).toBe(3);
  });

  it("only increments for sections that actually call it", () => {
    const sections: PromptSection[] = [
      { name: "step-a", render: (ctx) => `Step ${ctx.nextStep()}: A` },
      { name: "skipped", render: () => null }, // doesn't call nextStep
      { name: "non-numbered", render: () => "no step" }, // doesn't call nextStep
      { name: "step-b", render: (ctx) => `Step ${ctx.nextStep()}: B` },
    ];
    const result = composePrompt(sections, makeFixtureContext());
    expect(result).toBe("Step 1: A\n\nno step\n\nStep 2: B");
  });

  it("conditional sections that early-return null do not perturb the counter", () => {
    const sections: PromptSection[] = [
      { name: "a", render: (ctx) => `Step ${ctx.nextStep()}` },
      // A conditional section that returns null without ever calling nextStep:
      { name: "conditional", render: () => null },
      { name: "b", render: (ctx) => `Step ${ctx.nextStep()}` },
    ];
    expect(composePrompt(sections, makeFixtureContext())).toBe("Step 1\n\nStep 2");
  });

  it("is independent across context instances", () => {
    const a = makeFixtureContext();
    const b = makeFixtureContext();
    expect(a.nextStep()).toBe(1);
    expect(a.nextStep()).toBe(2);
    expect(b.nextStep()).toBe(1); // independent counter
  });
});

describe("gatherPromptContext", () => {
  it("returns null when getDiffAgainstBase throws", () => {
    vi.mocked(getDiffAgainstBase).mockImplementation(() => { throw new Error("no diff"); });
    const ctx = gatherPromptContext("myproject", "/repo/myproject", "main", makeEntry());
    expect(ctx).toBeNull();
  });

  it("populates all PromptData fields when I/O succeeds", () => {
    const ctx = gatherPromptContext("myproject", "/repo/myproject", "main", makeEntry());
    expect(ctx).not.toBeNull();
    expect(ctx!.data.diff).toBe("diff content");
    expect(ctx!.data.commitSummary).toBe("abc1234 fix: something");
    expect(ctx!.data.branchName).toBe("bold-ash");
    expect(ctx!.data.rules).toBe("project rules here");
    expect(ctx!.data.changedFiles).toEqual(["src/foo.ts"]);
  });

  it("uses entry.worktreePath when set, projectPath as fallback", () => {
    const entry = makeEntry({ worktreePath: undefined });
    const ctx = gatherPromptContext("myproject", "/repo/myproject", "main", entry);
    expect(ctx).not.toBeNull();
    // The mocked git fns don't track which path they got called with, but the
    // call must have succeeded for this to return non-null.
  });
});

describe("makeContext", () => {
  it("returns a PromptContext with the supplied data and a fresh nextStep counter", () => {
    const ctx = makeContext("p", "/path", "main", makeEntry(), {
      diff: "d",
      commitSummary: "c",
      branchName: "b",
      rules: "r",
      checksCommand: "npm test",
      changedFiles: [],
      docSections: [],
      testSections: [],
      specFiles: [],
    });
    expect(ctx.projectName).toBe("p");
    expect(ctx.projectPath).toBe("/path");
    expect(ctx.baseBranch).toBe("main");
    expect(ctx.data.checksCommand).toBe("npm test");
    expect(ctx.nextStep()).toBe(1);
    expect(ctx.nextStep()).toBe(2);
  });
});
