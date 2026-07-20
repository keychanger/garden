// Crews: named bundles of role -> "member" assignments, sugar over the
// per-role resolution (project.harness/provider for the worker, project.roles
// for the review family). A crew is a pair of members — `<worker>-<reviewer>`,
// with `all-X` sugar when one harness both builds and reviews.
//
// A MEMBER is data, not code: the registered harnesses (claude, codex, ...)
// plus one per configured provider (a claude-code worker against that backend,
// e.g. deepseek). So a new provider or harness expands the crew set with zero
// crew code — the axis-1 (provider) / axis-2 (harness) split stays orthogonal
// and both compose under one operator-facing concept.
//
// The load-bearing asymmetry: any member may BUILD (worker), but only
// harness members may REVIEW. A provider on a review role defeats the safety
// net (a cheap/experimental worker must be reviewed by a strong first-party
// model), so provider members are worker-only. See docs/future/CREWS.md.
//
// Crews are BOUND BY REFERENCE: a project stores `crew: <name>` and the members
// resolve at spawn/review time, so editing a definition propagates to every
// project on it. The flat project keys (harness/provider/model/effort, roles.*)
// are the override layer above the crew. Operator-defined crews live under
// `crews` in ~/.garden/config.yml; the original generated set survives as
// BUILTINS so every existing config, doc reference, and test keeps resolving
// with no migration.
import {
  loadConfig,
  saveConfig,
  type CrewRole,
  REVIEW_EFFORT_LEVELS,
  isValidReviewEffort,
  type GardenConfig,
  type ProjectConfig,
  type StoredCrew,
} from "../config.js";
import { harnessNames } from "./harness/core.js";

const DEFAULT_HARNESS = "claude-code";

// A crew's worker effort answers the same question as the flat `effort` project
// key and renders through the same `--effort <level>`, so it takes the same
// values: the four claude-code rungs plus "ultra" (the ultracode preset). Kept
// as a local literal for the same reason project-config-mutate.ts does — this
// module must not pull in create.ts's module graph.
const CREW_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "ultra"] as const;
// Operator-facing member name for the claude-code harness. Other harnesses and
// providers use their own name.
const CLAUDE_MEMBER = "claude";

export interface CrewMember {
  /** Operator-facing name: claude / codex / <provider> / <other-harness>. */
  name: string;
  harness: string;
  /** Provider backend (worker-only; a reviewer member never carries one). */
  provider?: string;
  /** Model pin for this half. Opaque string; absent = resolve down the chain. */
  model?: string;
  /** Reasoning effort. Both halves carry one, from different ladders: the
   *  worker's rungs plus "ultra" (the ultracode preset), the reviewer's plus
   *  "max" (a literal effort level — a headless run has no preset to enable). */
  effort?: string;
}

export interface CrewSpec {
  name: string;
  worker: CrewMember;
  /** Applies uniformly to reviewer / resolver / ci-fix in v1. */
  review: CrewMember;
  /** True for the generated cross-product crews (not editable/deletable). */
  builtin: boolean;
}

function harnessMemberName(harness: string): string {
  return harness === DEFAULT_HARNESS ? CLAUDE_MEMBER : harness;
}

// Every member available to a project: the registered harnesses, plus one per
// configured provider (claude-code against that backend).
export function listMembers(config: GardenConfig): CrewMember[] {
  const members: CrewMember[] = harnessNames().map((h) => ({ name: harnessMemberName(h), harness: h }));
  for (const p of Object.keys(config.providers ?? {})) {
    // A provider named exactly like a harness would collide; the harness member
    // (added first) wins on lookup. Vanishingly rare; not guarded in v1.
    members.push({ name: p, harness: DEFAULT_HARNESS, provider: p });
  }
  return members;
}

// Members eligible for a REVIEW role: harness-only, never provider-backed.
export function reviewerMembers(config: GardenConfig): CrewMember[] {
  return listMembers(config).filter((m) => !m.provider);
}

function crewName(worker: CrewMember, review: CrewMember): string {
  if (!worker.provider && worker.harness === review.harness) return `all-${review.name}`;
  return `${worker.name}-${review.name}`;
}

// One-line recipe: `claude opus/xhigh → claude opus`. The arrow reads
// build-then-review, matching the `<worker>-<reviewer>` builtin naming. Shared
// by `garden crew list/show` and the ⌥⇧C picker.
export function formatRecipe(spec: CrewSpec): string {
  const half = (m: CrewMember): string => {
    const dims = [m.model, m.effort].filter(Boolean).join("/");
    return dims ? `${m.name} ${dims}` : m.name;
  };
  return `${half(spec.worker)} → ${half(spec.review)}`;
}

// Look up a member by its operator-facing name.
export function findMember(name: string, config: GardenConfig): CrewMember | null {
  return listMembers(config).find((m) => m.name === name) ?? null;
}

// The generated builtin crews: (every member) x (every reviewer member). These
// carry no model/effort — that is exactly what a generated namespace cannot
// express, and the reason stored crews exist.
export function builtinCrews(config: GardenConfig): CrewSpec[] {
  const crews: CrewSpec[] = [];
  for (const w of listMembers(config)) {
    for (const r of reviewerMembers(config)) {
      crews.push({ name: crewName(w, r), worker: w, review: r, builtin: true });
    }
  }
  return crews;
}

// Resolve one half of a stored crew against the member registry. Returns null
// when the member no longer exists (a removed provider), which makes the whole
// crew unresolvable — callers already treat an unknown crew as "fall through to
// the layer beneath" rather than failing the spawn.
function resolveRole(role: CrewRole, config: GardenConfig, allowProvider: boolean): CrewMember | null {
  const member = findMember(role.member, config);
  if (!member) return null;
  if (member.provider && !allowProvider) return null;
  return {
    ...member,
    ...(role.model ? { model: role.model } : {}),
    ...(role.effort ? { effort: role.effort } : {}),
  };
}

// The operator-defined crews, in config order.
export function storedCrews(config: GardenConfig): CrewSpec[] {
  const crews: CrewSpec[] = [];
  for (const [name, def] of Object.entries(config.crews ?? {})) {
    const worker = resolveRole(def.worker, config, true);
    const review = resolveRole(def.review, config, false);
    if (worker && review) crews.push({ name, worker, review, builtin: false });
  }
  return crews;
}

// Every crew available: stored first, then the builtins a stored name has not
// shadowed. A stored crew wins on collision, so an operator can redefine
// `all-codex` without losing the name.
export function listCrews(config: GardenConfig): CrewSpec[] {
  const stored = storedCrews(config);
  const taken = new Set(stored.map((c) => c.name));
  return [...stored, ...builtinCrews(config).filter((c) => !taken.has(c.name))];
}

export function getCrew(name: string, config: GardenConfig): CrewSpec | null {
  return listCrews(config).find((c) => c.name === name) ?? null;
}

// The crew a project is BOUND to (its `crew` key), or null when unbound or the
// bound name no longer resolves. This is the read every resolution path uses;
// it is deliberately not the same question as deriveCrew (which also reports a
// name for legacy configs that only spell out flat keys).
export function resolveProjectCrew(
  project: Pick<ProjectConfig, "crew">,
  config: GardenConfig,
): CrewSpec | null {
  return project.crew ? getCrew(project.crew, config) : null;
}

function memberFor(harness: string, provider: string | undefined): CrewMember {
  return provider ? { name: provider, harness, provider } : { name: harnessMemberName(harness), harness };
}

// The operator-facing member name for a WORKER with the given harness, under a
// project's provider. Provider only applies to the claude-code harness (it is
// an Anthropic-compatible env swap); a foreign harness (codex) ignores it. Used
// by the status pane to badge a worker whose member differs from the project's.
export function workerMemberName(harness: string | undefined, provider: string | undefined): string {
  const h = harness ?? DEFAULT_HARNESS;
  return memberFor(h, h === DEFAULT_HARNESS ? provider : undefined).name;
}

// The member name a project's default worker resolves to (its harness + its
// provider) — the baseline the per-worker badge is compared against. Reads the
// same chain newWorker does: the flat key, then the bound crew's worker half
// (pass config to consult it), else the default. Without it a crew-bound
// project would report `claude` and badge every one of its own default workers.
export function projectWorkerMemberName(
  project: Pick<ProjectConfig, "harness" | "provider" | "crew">,
  config?: GardenConfig,
): string {
  const crewHarness = config ? resolveProjectCrew(project, config)?.worker.harness : undefined;
  return workerMemberName(project.harness ?? crewHarness, project.provider);
}

// The crew name pairing a worker's CURRENT build member (its fixed harness +
// provider) with a chosen REVIEW harness. Used by the worker menu to set a live
// worker's reviewer via entry.crew without disturbing its build half: the
// resulting crew's worker member matches what the worker already is, and its
// review member is the newly chosen reviewer (resolveReviewRole reads only the
// review half). getCrew resolves the returned name (it is a member × reviewer
// pairing).
export function crewNameFor(
  workerHarness: string | undefined,
  workerProvider: string | undefined,
  reviewHarness: string,
): string {
  const worker = memberFor(workerHarness ?? DEFAULT_HARNESS, workerProvider);
  const review = memberFor(reviewHarness, undefined);
  return crewName(worker, review);
}

// The crew name to SHOW for a project. Prefers the explicit binding; falls back
// to reverse-mapping the flat keys so a config written before crews were stored
// (or hand-tuned since) still reports a name. Returns null when the flat keys
// spell no named crew — the reviewer/resolver/ci-fix harnesses diverge, or a
// bound name no longer resolves. Read-only.
export function deriveCrew(project: ProjectConfig, config: GardenConfig): string | null {
  if (project.crew) return getCrew(project.crew, config) ? project.crew : null;
  const rev = project.roles?.reviewer?.harness ?? DEFAULT_HARNESS;
  const res = project.roles?.resolver?.harness ?? DEFAULT_HARNESS;
  const ci = project.roles?.ciFix?.harness ?? DEFAULT_HARNESS;
  if (rev !== res || rev !== ci) return null;
  const worker = memberFor(project.harness ?? DEFAULT_HARNESS, project.provider);
  const review = memberFor(rev, undefined);
  return crewName(worker, review);
}

// True when a project's flat keys override a dimension its bound crew also
// sets — the "adopted a crew, then tweaked it" state. Drives the `*` suffix on
// the status-pane badge so an override is never invisible. `provider` is not an
// override dimension: it is crew-managed by write-through (see applyCrew), so
// it is always already in sync.
export function crewOverridden(project: ProjectConfig, config: GardenConfig): boolean {
  const spec = resolveProjectCrew(project, config);
  if (!spec) return false;
  if (project.harness !== undefined) return true;
  if (spec.worker.model && project.model !== undefined) return true;
  if (spec.worker.effort && project.effort !== undefined) return true;
  return (["reviewer", "resolver", "ciFix"] as const).some((r) => {
    const t = project.roles?.[r];
    return t?.harness !== undefined
      || (spec.review.model !== undefined && t?.model !== undefined)
      || (spec.review.effort !== undefined && t?.effort !== undefined);
  });
}

// Bind a project to a crew. Under reference binding this records the NAME and
// clears the flat keys the crew now owns — the inverse of the shipped
// write-through behavior. Clearing is what makes the binding live: a stale flat
// `harness` left behind would sit in the override layer and permanently shadow
// the crew, so editing the crew later would appear to do nothing.
//
// Deliberately narrow: it clears only the dimensions the crew actually sets. A
// crew with no worker model leaves `project.model` alone, because that key is
// then answering a question the crew never asked.
//
// PROVIDER IS THE ONE EXCEPTION — it is written through to the flat key rather
// than bound by reference. Its readers (resolveProvider, projectUsageGateExempt
// in config.ts, reviewerEnvPrefix in claude-env.ts, `garden provider list`) sit
// below crew.ts in the import graph and cannot consult a crew without a cycle,
// and docs/future/CREWS.md rules that worker-provider stays the flat key to
// avoid split-brain. So the crew owns the value, but the value lives in
// `project.provider` where every reader already looks.
export function applyCrew(projectName: string, spec: CrewSpec): void {
  const config = loadConfig();
  const project = config.projects[projectName];
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  project.crew = spec.name;
  delete project.harness;
  if (spec.worker.provider) project.provider = spec.worker.provider;
  else delete project.provider;
  if (spec.worker.model) delete project.model;
  if (spec.worker.effort) delete project.effort;

  const roles = project.roles ?? {};
  for (const role of ["reviewer", "resolver", "ciFix"] as const) {
    const target = roles[role];
    if (!target) continue;
    delete target.harness;
    if (spec.review.model) delete target.model;
    if (spec.review.effort) delete target.effort;
    if (Object.keys(target).length === 0) delete roles[role];
  }
  if (Object.keys(roles).length === 0) delete project.roles;
  else project.roles = roles;

  saveConfig(config);
}

// Unbind a project from its crew, leaving the flat keys as-is. The project
// keeps whatever it currently resolves to, now spelled out rather than named.
export function clearCrew(projectName: string): void {
  const config = loadConfig();
  const project = config.projects[projectName];
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  delete project.crew;
  saveConfig(config);
}

// --- CRUD over stored definitions -------------------------------------------

export function isBuiltinCrew(name: string, config: GardenConfig): boolean {
  return !config.crews?.[name] && builtinCrews(config).some((c) => c.name === name);
}

// Validate a definition against the member registry and the review asymmetry.
// Throws with an operator-readable message; callers surface it verbatim.
export function validateCrewDef(def: StoredCrew, config: GardenConfig): void {
  const names = listMembers(config).map((m) => m.name);
  if (!findMember(def.worker.member, config)) {
    throw new Error(`Unknown member '${def.worker.member}'. Available: ${names.join(", ")}`);
  }
  const review = findMember(def.review.member, config);
  if (!review) {
    throw new Error(`Unknown member '${def.review.member}'. Available: ${names.join(", ")}`);
  }
  if (def.review.effort && !isValidReviewEffort(def.review.effort)) {
    throw new Error(
      `Unknown review effort '${def.review.effort}'. Levels: ${REVIEW_EFFORT_LEVELS.join(", ")}.`,
    );
  }
  // The load-bearing asymmetry: a provider on a review role defeats the safety
  // net that a cheap/experimental worker is checked by a strong first-party
  // model. Enforced here so it cannot be smuggled in via a stored definition.
  if (review.provider) {
    const ok = reviewerMembers(config).map((m) => m.name).join(", ");
    throw new Error(
      `Member '${def.review.member}' is provider-backed and cannot review. Reviewer members: ${ok}`,
    );
  }
  if (def.worker.effort && !(CREW_EFFORT_VALUES as readonly string[]).includes(def.worker.effort)) {
    throw new Error(`effort must be one of: ${CREW_EFFORT_VALUES.join(", ")}, got '${def.worker.effort}'`);
  }
}

export function saveCrew(name: string, def: StoredCrew): void {
  const config = loadConfig();
  validateCrewDef(def, config);
  config.crews = { ...(config.crews ?? {}), [name]: def };
  saveConfig(config);
}

// Remove a stored definition. Projects bound to it fall back to their flat keys
// (deriveCrew reports null, resolution skips the crew layer) rather than
// breaking — the binding is a reference, and a dangling one is inert.
export function deleteCrew(name: string): string[] {
  const config = loadConfig();
  if (!config.crews?.[name]) throw new Error(`No stored crew '${name}'.`);
  delete config.crews[name];
  if (Object.keys(config.crews).length === 0) delete config.crews;
  const bound = Object.entries(config.projects)
    .filter(([, p]) => p.crew === name)
    .map(([n]) => n);
  saveConfig(config);
  return bound;
}
