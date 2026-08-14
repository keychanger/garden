// Planner workflow definition: a decomposition worker whose unit of output is
// a bead DAG written to the project's bd store — never code, never a commit.
// The plan:* lifecycle is board's docs/DELEGATION.md phase 4d: board arms an
// epic `plan:pending`; garden's intake loop consumes that to `plan:planning`
// and spawns exactly one planner (poller-intake.ts); the planner reads the
// epic's design doc, emits the child DAG as ephemeral wisps plus an
// `integration`-labeled child, and finishes by rewriting the label to
// `plan:ready` (or `plan:failed`). board renders the draft dimmed and the
// operator's S promotes it — the planner itself never promotes.
//
// The workflow reuses the DEFAULT state handlers, exactly like botanist. The
// decomposition posture comes from the rules inversion (src/rules.ts planner
// branch) and the bundled `planner` skill; the exact bd contract rides the
// intake-built seed (buildPlannerSeed). Because a planner writes only to the
// bd store, its branch never gains a tracked commit — handleWorking sees zero
// commits ahead and the worker idles after finishing, like a botanist at its
// human gate. skipsReviewMerge covers the drift case: a planner that somehow
// commits rides the same publishable-path boundary check as botanist.
import { handleCiFixing } from "../poller-ci-fix.js";
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleDone } from "../poller-state.js";
import { plannerValidTransitions, type WorkflowDefinition } from "./types.js";

export const plannerWorkflow: WorkflowDefinition = {
  name: "planner",
  validTransitions: plannerValidTransitions,
  stateHandlers: {
    working: handleWorking,
    reviewing: handleReviewing,
    "merge-pending": handleMergePending,
    resolving: handleResolving,
    "ci-fixing": handleCiFixing,
    failing: handleFailing,
    merged: handleMerged,
    done: handleDone,
  },
  // The decomposition seat: cutting a design doc into a dependency-gated DAG
  // is judgment-heavy, so a planner defaults to Opus at max reasoning effort
  // — the same designer-seat defaults as botanist, layered beneath a
  // per-spawn --model / --effort.
  workerModel: "opus",
  workerEffort: "xhigh",
  // No reviewerModel — a planner branch runs no reviewer (its deliverable
  // lives in the bd store; board's S promotion is the review gate).
  skipsReviewMerge: true,
};
