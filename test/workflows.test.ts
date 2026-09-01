import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  defaultWorkflow,
  growWorkflow,
  trellisWorkflow,
  designerWorkflow,
  plannerWorkflow,
  getWorkflow,
  registerWorkflow,
  _resetUnknownWarnDedup,
  type WorkflowDefinition,
  type StateHandler,
} from "../src/dashboard/workflows/index.js";
import { getValidTransitions } from "../src/dashboard/workflows/types.js";
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
    "ci-fixing": noop,
    failing: noop,
    merged: noop,
    done: noop,
  };
}

// Literal copy of the current VALID_TRANSITIONS table, checked into this
// test so the deep-equal assertion can't pass via self-comparison. If this
// test fails after a refactor, either the production table changed
// (intentional — update this copy) or the refactor mutated it (bug).
// The default state machine. reviewing→done and done→reviewing are the holistic
// whole-task final-review edges (poller-holistic-review.ts): a multi-phase worker
// that reaches done gets one interposed aggregated review, which finalizes back
// to done (CLEAN) or re-opens done→reviewing to run.
const PRE_REFACTOR_VALID_TRANSITIONS: Record<PrState, PrState[]> = {
  working:         ["reviewing", "failing"],
  reviewing:       ["merge-pending", "working", "failing", "done"],
  "merge-pending": ["merged", "done", "resolving", "ci-fixing", "working", "failing"],
  resolving:       ["merge-pending", "working", "failing"],
  "ci-fixing":     ["merge-pending", "working", "failing"],
  failing:         ["working"],
  merged:          ["working", "done"],
  done:            ["working", "reviewing"],
};

// Every value in the PrState union. Driven by registry.ts; if a new state
// is added there, this list and the exhaustiveness test must be updated.
const ALL_PR_STATES: PrState[] = [
  "working", "reviewing", "merge-pending", "resolving", "ci-fixing",
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

  it("default workflow leaves workerModel/reviewerModel unset (no behavior change)", () => {
    expect(defaultWorkflow.workerModel).toBeUndefined();
    expect(defaultWorkflow.reviewerModel).toBeUndefined();
  });
});

describe("growWorkflow", () => {
  // The grow workflow is currently skeletal: reuses default's handlers.
  // Behavior divergence (per-iteration cold respawn, grow-flavored continue
  // prompt) is not yet wired.

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

  it("leaves workerModel and reviewerModel unset (account default applies)", () => {
    // Grow is bounded by iteration count, not by quality concerns about
    // model selection — so neither the worker nor the reviewer model is
    // pinned at the workflow level.
    expect(growWorkflow.workerModel).toBeUndefined();
    expect(growWorkflow.reviewerModel).toBeUndefined();
  });
});

describe("designerWorkflow", () => {
  // Reuses default's handlers (a designer's design phases
  // produce no tracked commit, so handleWorking never launches a review — the
  // worker idles at the human gate). Its transition table carries the shipped
  // skip-review merge divergence used when the approved doc is published.

  it("is registered under name 'designer'", () => {
    expect(getWorkflow("designer")).toBe(designerWorkflow);
  });

  it("diverges from default only on `working`: skip-review goes to merge-pending/failing, never reviewing", () => {
    // Every other state reuses default's edges (a docs branch can still hit a
    // rebase conflict -> resolving, red CI -> ci-fixing).
    expect(designerWorkflow.validTransitions.working).toEqual(["merge-pending", "failing", "done"]);
    expect(designerWorkflow.validTransitions.working).not.toContain("reviewing");
    for (const state of ALL_PR_STATES) {
      if (state === "working") continue;
      expect(designerWorkflow.validTransitions[state]).toEqual(PRE_REFACTOR_VALID_TRANSITIONS[state]);
    }
  });

  it("getValidTransitions('designer') returns the designer table (live path, not the dead field)", () => {
    expect(getValidTransitions("designer")).toBe(designerWorkflow.validTransitions);
    expect(getValidTransitions("designer").working).toEqual(["merge-pending", "failing", "done"]);
  });

  it("has a registered handler for every PrState (exhaustiveness)", () => {
    for (const state of ALL_PR_STATES) {
      expect(
        designerWorkflow.stateHandlers[state],
        `designer workflow missing handler for state ${state}`,
      ).toBeDefined();
    }
  });

  it("declares the designer seat: workerModel 'opus', workerEffort 'xhigh', no reviewerModel", () => {
    // Design is judgment-heavy, so the designer defaults to Opus at max effort.
    // No reviewerModel — a designer branch runs no reviewer.
    expect(designerWorkflow.workerModel).toBe("opus");
    expect(designerWorkflow.workerEffort).toBe("xhigh");
    expect(designerWorkflow.reviewerModel).toBeUndefined();
  });

  it("skipsReviewMerge is true (its artifact is prose the operator reviewed at the gate)", () => {
    expect(designerWorkflow.skipsReviewMerge).toBe(true);
    // Other workflows do not skip review.
    expect(defaultWorkflow.skipsReviewMerge).toBeUndefined();
    expect(growWorkflow.skipsReviewMerge).toBeUndefined();
  });
});

describe("plannerWorkflow", () => {
  // Designer-shaped: reuses default's handlers. A planner writes only to the
  // bd store, so its branch never gains a tracked commit and handleWorking
  // idles it after the plan lands; skipsReviewMerge covers the drift case.

  it("is registered under name 'planner'", () => {
    expect(getWorkflow("planner")).toBe(plannerWorkflow);
  });

  it("diverges from default only on `working`, like designer", () => {
    expect(plannerWorkflow.validTransitions.working).toEqual(["merge-pending", "failing", "done"]);
    expect(plannerWorkflow.validTransitions.working).not.toContain("reviewing");
    for (const state of ALL_PR_STATES) {
      if (state === "working") continue;
      expect(plannerWorkflow.validTransitions[state]).toEqual(PRE_REFACTOR_VALID_TRANSITIONS[state]);
    }
  });

  it("getValidTransitions('planner') returns the planner table", () => {
    expect(getValidTransitions("planner")).toBe(plannerWorkflow.validTransitions);
    expect(getValidTransitions("planner").working).toEqual(["merge-pending", "failing", "done"]);
  });

  it("has a registered handler for every PrState (exhaustiveness)", () => {
    for (const state of ALL_PR_STATES) {
      expect(
        plannerWorkflow.stateHandlers[state],
        `planner workflow missing handler for state ${state}`,
      ).toBeDefined();
    }
  });

  it("declares the decomposition seat: workerModel 'opus', workerEffort 'xhigh', no reviewerModel", () => {
    expect(plannerWorkflow.workerModel).toBe("opus");
    expect(plannerWorkflow.workerEffort).toBe("xhigh");
    expect(plannerWorkflow.reviewerModel).toBeUndefined();
  });

  it("skipsReviewMerge is true (its deliverable lives in the bd store, not a commit)", () => {
    expect(plannerWorkflow.skipsReviewMerge).toBe(true);
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
    };
    registerWorkflow(replacement);
    expect(getWorkflow("override-test")).toBe(replacement);
  });

  it("warns when a name is already registered", () => {
    const first: WorkflowDefinition = {
      name: "duplicate-test",
      validTransitions: { ...PRE_REFACTOR_VALID_TRANSITIONS },
      stateHandlers: stubStateHandlers(),
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
