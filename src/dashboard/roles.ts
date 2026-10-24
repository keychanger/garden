// Per-role resolution for the review family (reviewer / resolver / ci-fix):
// each role independently resolves its {harness, model, env}, arbitrary but
// opinionated-by-default. This is the layer that makes Codex-as-reviewer real
// (`garden config <p> role reviewer harness codex`) while keeping the safety
// net intact — the default is always a strong first-party Anthropic reviewer.
//
// The worker role resolves through resolveWorkerLaunchPlan; this file stays
// separate because review roles are INDEPENDENTLY knobbed, never a shared
// worker model/backend setting.
// See docs/MULTI-MODEL.md "Phase 4".
import { loadConfig, type GardenConfig, type ProjectConfig } from "../config.js";
import { reviewerEnvPrefix } from "./claude-env.js";
import { getWorkflow } from "./workflows/index.js";
import { getCrew, resolveProjectCrew } from "./crew.js";
import type { WorkerEntry } from "./registry.js";
import { resolveHeadlessLaunchPlan } from "./launch-plan.js";
import { canonicalHarnessName } from "./harness/core.js";
import type { HeadlessLaunchPlan, HeadlessRole } from "./harness/types.js";

export type ReviewRole = HeadlessRole;
export type ReviewRoleResolution = HeadlessLaunchPlan;

// Operator choice (2026-07): the review family defaults to explicit strong
// Anthropic Opus, so a cheap or experimental worker is never reviewed,
// resolved, or CI-fixed cheaply. Applied only on the claude-code path — a
// foreign harness (codex) uses its own harness default when unpinned (an
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
//
// Model and effort are the exception to "independently": a layer's model and
// effort name things in its own harness's vocabulary, so they apply only while
// that layer's harness, explicit or inherited from the layers beneath it, is
// the one reviewing — the review analog of newWorker's seatIfBuilding.
export function resolveReviewRole(
  project: Pick<ProjectConfig, "roles" | "claudeProfile" | "provider" | "crew">,
  workflow: string,
  role: ReviewRole,
  config?: GardenConfig,
  entry?: Pick<WorkerEntry, "crew">,
): ReviewRoleResolution {
  const target = project.roles?.[role] ?? {};
  // Read the config file only when a crew name actually needs resolving. The
  // crew-free chain is pure — requiring an initialized garden for it made this
  // function throw wherever no config exists (a bare CI runner), even though
  // nothing on that path reads one.
  const cfg = config ?? (entry?.crew || project.crew ? loadConfig() : undefined);
  const entryCrew = entry?.crew && cfg ? getCrew(entry.crew, cfg) : null;
  const projectCrew = cfg ? resolveProjectCrew(project, cfg) : null;
  // The harness each layer reviews on. Canonical names, because a hand-edited
  // config can spell claude-code by its member name `claude`, and the floor and
  // env checks below compare registry names: the alias would otherwise drop the
  // Opus floor and the profile env from a reviewer that still launches as
  // claude-code once the launch plan canonicalizes it.
  const crewHarness = projectCrew && canonicalHarnessName(projectCrew.review.harness);
  const roleHarness = canonicalHarnessName(target.harness ?? crewHarness ?? "claude-code");
  const harness = canonicalHarnessName(entryCrew?.review.harness ?? roleHarness);
  // A layer whose harness is not the one reviewing contributes no model or
  // effort: an explicit role harness over a bound crew would otherwise launch
  // Codex on the crew's Claude model (or claude-code on a Codex one), and a
  // per-worker crew would inherit a role model set for another harness. The
  // entry crew's harness is the resolved one whenever it exists.
  const roleSeat = roleHarness === harness ? target : undefined;
  const crewSeat = crewHarness === harness ? projectCrew?.review : undefined;
  // The reviewer inherits its workflow's reviewerModel when one is set;
  // resolver/ci-fix have no workflow source.
  const workflowModel = role === "reviewer" ? getWorkflow(workflow).reviewerModel : undefined;
  // Both the workflow model and SAFE_REVIEW_MODEL are Anthropic aliases,
  // meaningless to a foreign harness — so an unpinned foreign harness (codex)
  // gets no Anthropic model. Its launch plan supplies the Codex default.
  const model = entryCrew?.review.model
    ?? roleSeat?.model
    ?? crewSeat?.model
    ?? (harness === "claude-code" ? (workflowModel ?? SAFE_REVIEW_MODEL) : undefined);
  // Effort resolves on the same chain as model, but has NO default floor of
  // its own: the model chain falls back to Opus (the safety net that a cheap
  // worker still gets a strong review), whereas an unset effort is simply left
  // to the launch plan, which applies the target harness's own default — the
  // account default on claude-code (the behavior every review had before this
  // dial existed), DEFAULT_CODEX_EFFORT on codex. Both registered harnesses
  // accept every REVIEW_EFFORT_LEVELS rung, so nothing is mapped here.
  const effort = entryCrew?.review.effort ?? roleSeat?.effort ?? crewSeat?.effort;
  const envPrefix = harness === "claude-code" ? reviewerEnvPrefix(project, config) : "";
  return resolveHeadlessLaunchPlan({ role, harness, model, effort, envPrefix });
}
