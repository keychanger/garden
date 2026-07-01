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
import type { GardenConfig, ProjectConfig } from "../config.js";
import { reviewerEnvPrefix } from "./claude-env.js";
import { getWorkflow } from "./workflows/index.js";

export type ReviewRole = "reviewer" | "resolver" | "ciFix";

export interface ReviewRoleResolution {
  /** Harness adapter that runs this role (default "claude-code"). */
  harness: string;
  /** Model to pass the harness, or undefined for its own default. */
  model?: string;
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
//   model:   roles.<role>.model -> workflow.reviewerModel (reviewer only)
//            -> Opus (claude-code only) -> harness default
//   env:     claude-code -> the neutralizing first-party prefix (so a provider
//            worker's backend can't bleed into review); foreign harness -> ""
//            (it authenticates itself, e.g. Codex via ~/.codex/auth.json).
export function resolveReviewRole(
  project: Pick<ProjectConfig, "roles" | "claudeProfile" | "provider">,
  workflow: string,
  role: ReviewRole,
  config?: GardenConfig,
): ReviewRoleResolution {
  const target = project.roles?.[role] ?? {};
  const harness = target.harness ?? "claude-code";
  // The reviewer inherits its workflow's reviewerModel (trellis pins "opus"
  // per WORKFLOWS.md Invariant 10); resolver/ci-fix have no workflow source.
  const workflowModel = role === "reviewer" ? getWorkflow(workflow).reviewerModel : undefined;
  const model = target.model
    ?? workflowModel
    ?? (harness === "claude-code" ? SAFE_REVIEW_MODEL : undefined);
  const envPrefix = harness === "claude-code" ? reviewerEnvPrefix(project, config) : "";
  return { harness, model, envPrefix };
}
