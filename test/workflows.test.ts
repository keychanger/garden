import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  defaultWorkflow,
  growWorkflow,
  trellisWorkflow,
  getWorkflow,
  registerWorkflow,
  _resetUnknownWarnDedup,
  type WorkflowDefinition,
  type StateHandler,
} from "../src/dashboard/workflows/index.js";
import { log } from "../src/dashboard/log.js";
import type { PrState } from "../src/dashboard/registry.js";

// Test fixture: every workflow must register a handler for every PrState
// (the type is Record<PrState, StateHandler>, not Partial). Tests that don't
// care about handler behavior can use these no-op stubs and override the
// specific states they exercise.
function stubStateHandlers(): Record<PrState, StateHandler> {
  const noop: StateHandler = () => false;
  return {
    working: noop,
    reviewing: noop,
    "merge-pending": noop,
    resolving: noop,
    failing: noop,
    merged: noop,
    done: noop,
  };
}

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
      stateHandlers: stubStateHandlers(),
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
    // The dispatcher in hook-dispatcher.ts switches on event name and selects a
    // method; each event must have a corresponding handler. Catches
    // typos in the WorkflowHookHandlers type.
    expect(typeof defaultWorkflow.hookHandlers.onSessionStart).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onUserPromptSubmit).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onStop).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onNotification).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onPreToolUse).toBe("function");
    expect(typeof defaultWorkflow.hookHandlers.onPostToolUse).toBe("function");
  });

  it("hookHandlers are bound at module-init time (vitest sanity check)", () => {
    // Vitest sanity check only — it does NOT reproduce esbuild's bundling
    // order, so it cannot catch the module-init cycle on its own. The
    // load-bearing regression net is test/integration/claude-hook-bundled.real.test.ts,
    // which spawns the built bundle and triggers each hook event. That
    // bundled test is part of the default `npm test` (see vitest.config.ts).
    // Keep this assertion as cheap insurance against the source-level form
    // of the bug, but trust the bundled test for cycle regressions.
    expect(defaultWorkflow.hookHandlers).not.toBeUndefined();
    expect(defaultWorkflow.hookHandlers.onStop).not.toBeUndefined();
    expect(typeof defaultWorkflow.hookHandlers.onStop).toBe("function");
  });
});

describe("trellisWorkflow (phase 1 skeleton)", () => {
  // Phase 1 ships a skeletal trellis workflow that reuses default's handlers.
  // Behavior divergence (trellis-specific reviewer prompts, per-iteration
  // context reset, FLAGGED handling) lands in phase 2. See TRELLIS-PLAN.md.

  it("is registered under name 'trellis'", () => {
    expect(getWorkflow("trellis")).toBe(trellisWorkflow);
  });

  it("declares workerModel: 'sonnet' and reviewerModel: 'opus'", () => {
    expect(trellisWorkflow.workerModel).toBe("sonnet");
    expect(trellisWorkflow.reviewerModel).toBe("opus");
  });

  it("validTransitions deep-equal default's (no transition divergence in v1)", () => {
    expect(trellisWorkflow.validTransitions).toEqual(PRE_REFACTOR_VALID_TRANSITIONS);
  });

  it("has a registered handler for every PrState (exhaustiveness)", () => {
    for (const state of ALL_PR_STATES) {
      expect(
        trellisWorkflow.stateHandlers[state],
        `trellis workflow missing handler for state ${state}`,
      ).toBeDefined();
    }
  });

  it("phase 1 reuses default's hookHandlers verbatim", () => {
    // Phase 2 may override individual hook methods; phase 1 confirms
    // identity reuse so Stop/UserPromptSubmit/SessionStart wiring is
    // shared with default workers.
    expect(trellisWorkflow.hookHandlers).toBe(defaultWorkflow.hookHandlers);
  });

  it("default workflow leaves workerModel/reviewerModel unset (no behavior change)", () => {
    expect(defaultWorkflow.workerModel).toBeUndefined();
    expect(defaultWorkflow.reviewerModel).toBeUndefined();
  });
});

describe("growWorkflow (phase 2 skeleton)", () => {
  // Phase 2 ships a skeletal grow workflow that reuses default's handlers.
  // Behavior divergence (per-iteration cold respawn, grow-flavored continue
  // prompt) lands in phase 3. See declarative-singing-graham.md.

  it("is registered under name 'grow'", () => {
    expect(getWorkflow("grow")).toBe(growWorkflow);
  });

  it("validTransitions deep-equal default's (grow uses the same state machine)", () => {
    expect(growWorkflow.validTransitions).toEqual(PRE_REFACTOR_VALID_TRANSITIONS);
  });

  it("has a registered handler for every PrState (exhaustiveness)", () => {
    for (const state of ALL_PR_STATES) {
      expect(
        growWorkflow.stateHandlers[state],
        `grow workflow missing handler for state ${state}`,
      ).toBeDefined();
    }
  });

  it("phase 2 reuses default's hookHandlers verbatim", () => {
    // Phase 3 may override individual hook methods; phase 2 confirms identity
    // reuse so Stop/UserPromptSubmit/SessionStart wiring is shared.
    expect(growWorkflow.hookHandlers).toBe(defaultWorkflow.hookHandlers);
  });

  it("leaves workerModel and reviewerModel unset (account default applies)", () => {
    // Locked decisions 3 and 4: grow is bounded by N, not by quality concerns
    // about model selection. Operators tune via --model at plant time when
    // wired in phase 3 (or not at all for v1 if the flag is forbidden).
    expect(growWorkflow.workerModel).toBeUndefined();
    expect(growWorkflow.reviewerModel).toBeUndefined();
  });
});

describe("registerWorkflow", () => {
  it("overrides an existing entry with the same name", () => {
    const original = getWorkflow("override-test");
    expect(original).toBe(defaultWorkflow); // first call: unknown → fallback

    const replacement: WorkflowDefinition = {
      name: "override-test",
      validTransitions: { ...PRE_REFACTOR_VALID_TRANSITIONS },
      stateHandlers: stubStateHandlers(),
      hookHandlers: defaultWorkflow.hookHandlers,
    };
    registerWorkflow(replacement);
    expect(getWorkflow("override-test")).toBe(replacement);
  });

  it("warns when a name is already registered", () => {
    const first: WorkflowDefinition = {
      name: "duplicate-test",
      validTransitions: { ...PRE_REFACTOR_VALID_TRANSITIONS },
      stateHandlers: stubStateHandlers(),
      hookHandlers: defaultWorkflow.hookHandlers,
    };
    registerWorkflow(first);
    vi.mocked(log.warn).mockClear();

    const second: WorkflowDefinition = { ...first };
    registerWorkflow(second);
    expect(log.warn).toHaveBeenCalledWith(
      "workflows",
      "workflow already registered, overwriting",
      expect.objectContaining({ data: { name: "duplicate-test" } }),
    );
  });
});
