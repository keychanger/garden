// Per-role resolution for the review family (reviewer / resolver / ci-fix):
// each role independently resolves its {harness, model, env}, arbitrary but
// opinionated-by-default. This is the layer that makes Codex-as-reviewer real
// (`garden config <p> role reviewer harness codex`) while keeping the safety
// net intact — the default is always a strong first-party Anthropic reviewer.
//
// The worker role resolves elsewhere (workerEnvPrefix + entry.harness/model);
// worker harness selection lands in the worker-path slice. Kept separate on
// purpose: roles are INDEPENDENTLY knobbed, never a shared model setting.
// See docs/MULTI-MODEL.md "Phase 4".
import { loadConfig, type GardenConfig, type ProjectConfig } from "../config.js";
import { reviewerEnvPrefix } from "./claude-env.js";
import { getWorkflow } from "./workflows/index.js";
import { getCrew, resolveProjectCrew } from "./crew.js";
import type { WorkerEntry } from "./registry.js";

export type ReviewRole = "reviewer" | "resolver" | "ciFix";

export interface ReviewRoleResolution {
  /** Harness adapter that runs this role (default "claude-code"). */
  harness: string;
  /** Model to pass the harness, or undefined for its own default. */
  model?: string;
  /** Reasoning effort, or undefined for the harness default. Resolved on the
   *  same chain as model; there is no safe-default floor (unlike
   *  SAFE_REVIEW_MODEL) because an unset effort already means "whatever the
   *  account does by default", which is the shipped behavior. */
  effort?: string;
  /** Env-assignment prefix for the launch (harness-aware). */
  envPrefix: string;
}

// Operator choice (2026-07): the review family defaults to explicit strong
// Anthropic Opus, so a cheap or experimental worker is never reviewed,
// resolved, or CI-fixed cheaply. Applied only on the claude-code path — a
// foreign harness (codex) uses its own account default when unpinned (an
// Anthropic alias would be meaningless there). Overridable per role via
// `garden config <p> role <role> model <m>`.
export const SAFE_REVIEW_MODEL = "opus";

// Resolve one review role. Each dimension resolves independently, first
// defined value wins:
//   harness: roles.<role>.harness -> "claude-code"
//   model:   roles.<role>.model -> (claude-code only: workflow.reviewerModel
//            (reviewer only) -> Opus) -> harness default
//   env:     claude-code -> the neutralizing first-party prefix (so a provider
//            worker's backend can't bleed into review); foreign harness -> ""
//            (it authenticates itself, e.g. Codex via ~/.codex/auth.json).
//
// Crews layer in at two levels, both above the harness default and both below
// an explicit per-role key:
//   - a PER-WORKER crew (entry.crew) — the live-changeable dimension; change it
//     and the next review/resolve/ci-fix uses the new reviewer.
//   - the PROJECT's bound crew (project.crew) — resolved by reference, so
//     editing the crew definition re-targets every project on it.
// So each dimension reads: entry crew -> project.roles.<role> -> project crew
// -> default. A crew never carries a review provider (the safety net is
// structural — validateCrewDef rejects it). Backward-compatible: with no crew
// anywhere, the chain is byte-identical to the pre-crew behavior.
export function resolveReviewRole(
  project: Pick<ProjectConfig, "roles" | "claudeProfile" | "provider" | "crew">,
  workflow: string,
  role: ReviewRole,
  config?: GardenConfig,
  entry?: Pick<WorkerEntry, "crew">,
): ReviewRoleResolution {
  const target = project.roles?.[role] ?? {};
  const cfg = config ?? loadConfig();
  const entryCrew = entry?.crew ? getCrew(entry.crew, cfg) : null;
  const projectCrew = resolveProjectCrew(project, cfg);
  const harness = entryCrew?.review.harness ?? target.harness ?? projectCrew?.review.harness ?? "claude-code";
  // The reviewer inherits its workflow's reviewerModel (trellis pins "opus"
  // per WORKFLOWS.md Invariant 10); resolver/ci-fix have no workflow source.
  const workflowModel = role === "reviewer" ? getWorkflow(workflow).reviewerModel : undefined;
  // Both the workflow model and SAFE_REVIEW_MODEL are Anthropic aliases,
  // meaningless to a foreign harness — so an unpinned foreign harness (codex)
  // gets NO model flag and uses its own account default. Only an explicit
  // model (per-role key or a crew's review pin) reaches a foreign harness.
  const model = entryCrew?.review.model
    ?? target.model
    ?? projectCrew?.review.model
    ?? (harness === "claude-code" ? (workflowModel ?? SAFE_REVIEW_MODEL) : undefined);
  // Effort resolves on the same chain as model, but has NO default floor: the
  // model chain falls back to Opus (the safety net that a cheap worker still
  // gets a strong review), whereas an unset effort simply means the account
  // default — the behavior every review had before this dial existed. It is
  // also claude-code-only, like the model aliases: a foreign harness has no
  // `--effort` to render, so passing one would be silently meaningless.
  const effort = harness === "claude-code"
    ? (entryCrew?.review.effort ?? target.effort ?? projectCrew?.review.effort)
    : undefined;
  const envPrefix = harness === "claude-code" ? reviewerEnvPrefix(project, config) : "";
  return { harness, model, effort, envPrefix };
}
