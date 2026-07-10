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
import { loadConfig, saveConfig, type GardenConfig, type ProjectConfig } from "../config.js";
import { harnessNames } from "./harness/core.js";

const DEFAULT_HARNESS = "claude-code";
// Operator-facing member name for the claude-code harness. Other harnesses and
// providers use their own name.
const CLAUDE_MEMBER = "claude";

export interface CrewMember {
  /** Operator-facing name: claude / codex / <provider> / <other-harness>. */
  name: string;
  harness: string;
  /** Provider backend (worker-only; a reviewer member never carries one). */
  provider?: string;
}

export interface CrewSpec {
  name: string;
  worker: CrewMember;
  /** Applies uniformly to reviewer / resolver / ci-fix in v1. */
  review: CrewMember;
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

// The generated set of valid crews: (every member) x (every reviewer member).
export function listCrews(config: GardenConfig): CrewSpec[] {
  const workers = listMembers(config);
  const reviews = reviewerMembers(config);
  const crews: CrewSpec[] = [];
  for (const w of workers) {
    for (const r of reviews) crews.push({ name: crewName(w, r), worker: w, review: r });
  }
  return crews;
}

export function getCrew(name: string, config: GardenConfig): CrewSpec | null {
  return listCrews(config).find((c) => c.name === name) ?? null;
}

function memberFor(harness: string, provider: string | undefined): CrewMember {
  return provider ? { name: provider, harness, provider } : { name: harnessMemberName(harness), harness };
}

// The crew a project currently resolves to, or null when its role assignment
// doesn't match a named crew (hand-tuned config — e.g. the reviewer/resolver/
// ci-fix harnesses diverge). Only the role *harnesses* are compared: per-role
// model pins are crew-orthogonal (applyCrew preserves them) and never force a
// null result. Read-only.
export function deriveCrew(project: ProjectConfig, _config: GardenConfig): string | null {
  const rev = project.roles?.reviewer?.harness ?? DEFAULT_HARNESS;
  const res = project.roles?.resolver?.harness ?? DEFAULT_HARNESS;
  const ci = project.roles?.ciFix?.harness ?? DEFAULT_HARNESS;
  if (rev !== res || rev !== ci) return null;
  const worker = memberFor(project.harness ?? DEFAULT_HARNESS, project.provider);
  const review = memberFor(rev, undefined);
  return crewName(worker, review);
}

// Apply a crew to a project's config. Authoritative over the worker harness +
// provider and the three review-role harnesses: it sets the crew's values and
// clears everything it manages back to default otherwise, so switching crews
// never strands a stale assignment. Per-role models and non-crew keys are left
// untouched.
export function applyCrew(projectName: string, spec: CrewSpec): void {
  const config = loadConfig();
  const project = config.projects[projectName];
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  if (spec.worker.harness === DEFAULT_HARNESS) delete project.harness;
  else project.harness = spec.worker.harness;
  if (spec.worker.provider) project.provider = spec.worker.provider;
  else delete project.provider;

  const roles = project.roles ?? {};
  for (const role of ["reviewer", "resolver", "ciFix"] as const) {
    const target = roles[role] ?? {};
    if (spec.review.harness === DEFAULT_HARNESS) delete target.harness;
    else target.harness = spec.review.harness;
    if (Object.keys(target).length === 0) delete roles[role];
    else roles[role] = target;
  }
  if (Object.keys(roles).length === 0) delete project.roles;
  else project.roles = roles;

  saveConfig(config);
}
