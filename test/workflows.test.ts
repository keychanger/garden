import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  defaultWorkflow,
  getWorkflow,
  registerWorkflow,
  _resetUnknownWarnDedup,
  type WorkflowDefinition,
} from "../src/dashboard/workflows/index.js";
import { log } from "../src/dashboard/log.js";
import type { PrState } from "../src/dashboard/registry.js";

// Literal copy of the pre-refactor VALID_TRANSITIONS table, checked into
// this test so the deep-equal assertion can't pass via self-comparison.
// If this test fails after a refactor, either the production table changed
// (intentional — update this copy) or the refactor mutated it (bug).
const PRE_REFACTOR_VALID_TRANSITIONS: Record<PrState, PrState[]> = {
  working:         ["reviewing"],
  reviewing:       ["merge-pending", "working", "failing"],
  "merge-pending": ["merged", "done", "resolving", "working"],
  resolving:       ["merge-pending", "working", "failing"],
  failing:         ["working"],
  merged:          ["working", "done"],
  done:            ["working"],
};

// Every value in the PrState union. Driven by registry.ts; if a new state
// is added there, this list and the exhaustiveness test must be updated.
const ALL_PR_STATES: PrState[] = [
  "working", "reviewing", "merge-pending", "resolving",
  "failing", "merged", "done",
];

beforeEach(() => {
  vi.clearAllMocks();
  _resetUnknownWarnDedup();
});

describe("getWorkflow", () => {
  it("returns the default workflow for the literal name 'default'", () => {
    expect(getWorkflow("default")).toBe(defaultWorkflow);
  });

  it("returns the default workflow for an unknown name and warns once", () => {
    const result = getWorkflow("nonexistent-workflow");
    expect(result).toBe(defaultWorkflow);
    expect(log.warn).toHaveBeenCalledWith(
      "workflows",
      "unknown workflow, falling back to default",
      expect.objectContaining({ data: { requested: "nonexistent-workflow" } }),
    );
  });

  it("dedupes the unknown-name warning across repeated calls", () => {
    getWorkflow("nonexistent-workflow");
    getWorkflow("nonexistent-workflow");
    getWorkflow("nonexistent-workflow");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("warns separately for each distinct unknown name", () => {
    getWorkflow("first-unknown");
    getWorkflow("second-unknown");
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("returns a registered workflow when its name matches", () => {
    const custom: WorkflowDefinition = {
      name: "test-workflow",
      validTransitions: { ...PRE_REFACTOR_VALID_TRANSITIONS },
      stateHandlers: {},
      hookHandlers: defaultWorkflow.hookHandlers,
    };
    registerWorkflow(custom);
    expect(getWorkflow("test-workflow")).toBe(custom);
  });
});

describe("defaultWorkflow", () => {
  it("has name 'default'", () => {
    expect(defaultWorkflow.name).toBe("default");
  });

  it("validTransitions is deep-equal to the pre-refactor literal table", () => {
    // The test checks the TABLE checked into this test, not what production
    // re-exports. A mutation in the production table that isn't matched by
    // an explicit update here is a bug — this is the regression net.
    expect(defaultWorkflow.validTransitions).toEqual(PRE_REFACTOR_VALID_TRANSITIONS);
  });

  it("has a registered handler for every PrState (exhaustiveness)", () => {
    for (const state of ALL_PR_STATES) {
      expect(
        defaultWorkflow.stateHandlers[state],
        `default workflow missing handler for state ${state}`,
      ).toBeDefined();
    }
  });

  it("every state in validTransitions is also a key in stateHandlers", () => {
    // Catches cases where a state has transitions defined but no handler —
    // that worker would be unprocessable in the dispatcher.
    const transitionKeys = Object.keys(defaultWorkflow.validTransitions);
    for (const state of transitionKeys) {
      expect(
        defaultWorkflow.stateHandlers[state as PrState],
        `state ${state} has transitions but no handler`,
      ).toBeDefined();
    }
  });

  it("every transition target is itself a known PrState", () => {
    // Catches typos in transition targets (e.g., "merging" vs "merge-pending").
    const knownStates = new Set(ALL_PR_STATES);
    for (const [from, targets] of Object.entries(defaultWorkflow.validTransitions)) {
      for (const target of targets) {
        expect(
          knownStates.has(target),
          `${from} has unknown transition target ${target}`,
        ).toBe(true);
      }
    }
  });

  it("hookHandlers are wired to defaultHookHandlers (Phase 4)", () => {
    // Phase 4 wires the real handlers. A null workerInfo context is the
    // "hook fired outside any worktree" case — the handler must early-return
    // without throwing or mutating any registry state.
    expect(() =>
      defaultWorkflow.hookHandlers.onStop({ event: "stop", input: {}, workerInfo: null })
    ).not.toThrow();
  });

  it("hookHandlers exposes one method per Claude Code event", () => {
    // The dispatcher in header.ts switches on event name and selects a
    // method; each event must have a corresponding handler. Catches
    // typos in the WorkflowHookHandlers type.
    expect(typeof defaultWorkflow.hookHandlers.onSessionStart).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onUserPromptSubmit).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onStop).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onNotification).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onPreToolUse).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onPostToolUse).toBe("function");
  });

  it("hookHandlers are bound at module-init time (no cycle re-introduction)", () => {
    // Regression net for the module-init cycle that previously forced
    // hookHandlers to be a getter (workflows/default.ts:42). If a future
    // import widens the cycle through hooks/default.ts, defaultHookHandlers
    // would be undefined at object-literal time and these direct-property
    // checks would fail. Compare with `not.toBeUndefined` to make the
    // failure mode explicit if it regresses.
    expect(defaultWorkflow.hookHandlers).not.toBeUndefined();
    expect(defaultWorkflow.hookHandlers.onStop).not.toBeUndefined();
    expect(typeof defaultWorkflow.hookHandlers.onStop).toBe("function");
  });
});

describe("registerWorkflow", () => {
  it("overrides an existing entry with the same name", () => {
    const original = getWorkflow("override-test");
    expect(original).toBe(defaultWorkflow); // first call: unknown → fallback

    const replacement: WorkflowDefinition = {
      name: "override-test",
      validTransitions: { ...PRE_REFACTOR_VALID_TRANSITIONS },
      stateHandlers: {},
      hookHandlers: defaultWorkflow.hookHandlers,
    };
    registerWorkflow(replacement);
    expect(getWorkflow("override-test")).toBe(replacement);
  });
});
