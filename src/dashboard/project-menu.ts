// The ⌥, project config menu: inspect + set a project's configuration. Every
// row shows the current value inline, so the menu doubles as the inspector.
// Rows dispatch a submenu, a toggle, or `_config-set <p> <key> <value>` — all
// routed through the shared setProjectConfigKey mutator
// (dashboard/project-config-mutate.ts), so the menu and the `garden config` CLI
// share one writer and one set of validation.
//
// Deliberately narrow: the everyday project knobs (base branch, crew, CI gate,
// holistic review, log color). The rarely-touched / power-user surfaces —
// per-role review harness ("roles", subsumed by crew for the common case),
// claude profile, provider, and free-form values (checks / post-merge / sandbox
// / iteration caps) — stay on the `garden config` CLI, out of the menu. checks +
// post-merge are shown in the title so they remain visible at a glance.
//
// Plan builders are pure (a view/data object -> MenuSpec) and tested; each
// mutating handler re-opens the menu (form feel) after refreshing the pane.
import { loadConfig, tryGetProject, DEFAULT_HOLISTIC_REVIEW, type GardenConfig, type ProjectConfig } from "../config.js";
import { readDashState } from "./state.js";
import { resolveGardenRunner } from "./runner.js";
import { shellEscape, tmuxDisplay } from "./tmux.js";
import { runMenu, type MenuSpec, type MenuRow } from "./menu.js";
import { refreshDashboard } from "./header.js";
import { deriveCrew, findMember, projectWorkerMemberName, resolveProjectCrew } from "./crew.js";
import { composerEfforts, composerModels, providerModelAliases } from "./harness/vocabulary.js";
import { ASSIGNABLE_LOG_COLOR_KEYS } from "../log-palette.js";
import { setProjectConfigKey, SETTABLE_KEYS, type SettableKey } from "./project-config-mutate.js";
import { listBranches, resolveBaseBranch } from "./git.js";
import { log } from "./log.js";

const NOT_SET = "(not set)";
const trunc = (s: string, n = 28): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// The model and effort choices for the project's builder, the member its
// default workers build with: the ⌥⇧N composer's lists with nothing staged, so
// a Codex-building project is offered Codex's catalog and levels rather than
// Anthropic aliases its workers would launch as `codex -m opus`. "ultra" names
// the claude-code ultracode preset at this level, which another builder's
// workers skip, so only a claude-code builder is offered it. The CLI
// (`garden config <p> model <id>`) covers exotic model ids.
export function projectBuilderChoices(
  project: ProjectConfig,
  config: GardenConfig,
): { models: string[]; efforts: string[] } {
  const member = findMember(projectWorkerMemberName(project, config), config);
  const harness = member?.harness ?? "claude-code";
  const aliases = member?.provider ? providerModelAliases(member.provider, config) : undefined;
  return {
    models: composerModels(harness, aliases),
    efforts: composerEfforts(harness).filter(e => e !== "ultra" || harness === "claude-code"),
  };
}

// ---- pure plan builders --------------------------------------------------

export interface ProjectMenuView {
  project: string;
  runner: string;
  base: string;
  crew: string;
  ciGate: boolean;
  holistic: string;
  logColor: string;
  model: string;
  effort: string;
  checks: string;
  postMerge: string;
}

export function buildProjectMenuPlan(v: ProjectMenuView): MenuSpec {
  const p = shellEscape(v.project);
  const g = v.runner;
  const sub = (name: string) => `${g} dashboard ${name} ${p}`;
  // crew and model/effort sit adjacent because they overlap: a stored crew can
  // pin model/effort too, and these flat keys are the override layer above it.
  const rows: MenuRow[] = [
    { label: `(1) base branch      ${v.base}`, key: "1", run: sub("_config-branch-submenu") },
    { label: `(2) crew             ${v.crew}`, key: "2", run: `${g} dashboard _crew-picker ${p}` },
    { label: `(3) model            ${v.model}`, key: "3", run: sub("_config-model-submenu") },
    { label: `(4) effort           ${v.effort}`, key: "4", run: sub("_config-effort-submenu") },
    { label: `(5) CI gate          ${v.ciGate ? "on" : "off"}`, key: "5", run: `${g} dashboard _config-set ${p} requireCiSuccess ${v.ciGate ? "false" : "true"}` },
    { label: `(6) holistic review  ${v.holistic}`, key: "6", run: sub("_config-holistic-submenu") },
    { label: `(7) log color        ${v.logColor}`, key: "7", run: sub("_config-color-submenu") },
  ];
  return {
    title: `Project ${v.project} · checks: ${trunc(v.checks, 30)} · post-merge: ${trunc(v.postMerge, 24)}`,
    rows,
  };
}

// A generic single-value submenu: one row per option (current marked), each
// dispatching `_config-set <p> <key> <value>`, plus an unset row.
export function buildEnumSubmenuPlan(
  project: string, key: string, title: string, options: string[], current: string | undefined, runner: string, unsetLabel = "unset",
): MenuSpec {
  const p = shellEscape(project);
  const rows: MenuRow[] = options.map((o, i) => ({
    label: o === current ? `${o}  ✓` : o,
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _config-set ${p} ${key} ${shellEscape(o)}`,
  }));
  rows.push({ label: `(0) ${unsetLabel}`, key: "0", run: `${runner} dashboard _config-set ${p} ${key} ${shellEscape("")}` });
  return { title, rows };
}

export function buildProjectBranchSubmenuPlan(project: string, branches: string[], current: string | undefined, runner: string): MenuSpec {
  return buildEnumSubmenuPlan(project, "baseBranch", `Base branch for ${project} (new workers)`, branches, current, runner, "unset — follow the checkout");
}

export function buildHolisticSubmenuPlan(project: string, current: string, runner: string): MenuSpec {
  return buildEnumSubmenuPlan(project, "holisticReview", `Holistic review for ${project}`, ["off", "shadow", "fix"], current, runner, `unset — default (${DEFAULT_HOLISTIC_REVIEW})`);
}

// Default worker model (default + grow workers), offered from the builder's
// list (projectBuilderChoices). This flat key is the override layer above a
// bound crew's own model pin.
export function buildProjectModelSubmenuPlan(project: string, models: string[], current: string | undefined, runner: string): MenuSpec {
  return buildEnumSubmenuPlan(project, "model", `Default model for ${project} (default+grow workers)`, models, current, runner, "unset — account/provider default");
}

// Default reasoning effort (default + grow workers), offered from the builder's
// ladder (projectBuilderChoices). A claude-code builder's ends in "ultra", the
// ultracode preset (max effort + dynamic workflows) rather than a rung; a Codex
// builder's adds "max", rendered as `model_reasoning_effort` like the rest.
export function buildProjectEffortSubmenuPlan(project: string, efforts: string[], current: string | undefined, runner: string): MenuSpec {
  const title = efforts.includes("ultra")
    ? `Default effort for ${project} (ultra = ultracode preset)`
    : `Default effort for ${project}`;
  return buildEnumSubmenuPlan(project, "effort", title, efforts, current, runner, "unset — no effort passed");
}

// ---- runners (resolve data, drive tmux) ----------------------------------

function focusedProject(explicit?: string): string | null {
  if (explicit) return explicit;
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No active project. Use ⌥1-⌥9 to select one first.");
    return null;
  }
  return state.activeProject;
}

export function runProjectMenu(explicitProject?: string): void {
  const name = focusedProject(explicitProject);
  if (!name) return;
  const config = loadConfig();
  const project = config.projects[name];
  if (!project) {
    tmuxDisplay(`Unknown project '${name}'.`);
    return;
  }
  runMenu(buildProjectMenuPlan(projectMenuView(name, project, config)));
}

// Pure view builder (exported for tests). A crew-bound project's model/effort
// may come from the crew rather than a flat key, so the row reports the crew
// value tagged with its source — otherwise the menu reads "account default" on
// a project whose crew pins opus.
export function projectMenuView(name: string, project: ProjectConfig, config: GardenConfig): ProjectMenuView {
  const crew = resolveProjectCrew(project, config);
  return {
    project: name,
    runner: resolveGardenRunner(),
    // Always show the EFFECTIVE base: an explicit pin, else the branch new
    // workers actually resolve to (checkout → origin/HEAD → main), tagged
    // "(default)" — there is always a base, so never "(not set)".
    base: project.baseBranch ?? `${resolveBaseBranch(project.path)} (default)`,
    crew: deriveCrew(project, config) ?? "custom",
    ciGate: project.requireCiSuccess ?? true,
    holistic: project.holisticReview ?? `${DEFAULT_HOLISTIC_REVIEW} (default)`,
    logColor: project.logColor ?? "auto",
    model: project.model ?? (crew?.worker.model ? `${crew.worker.model} (crew ${crew.name})` : "account default"),
    effort: project.effort ?? (crew?.worker.effort ? `${crew.worker.effort} (crew ${crew.name})` : "default"),
    checks: project.checks ?? NOT_SET,
    postMerge: project.postMerge ?? NOT_SET,
  };
}

export function runProjectBranchSubmenu(project: string): void {
  const proj = tryGetProject(project);
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildProjectBranchSubmenuPlan(project, listBranches(proj.path), proj.baseBranch, resolveGardenRunner()));
}

export function runHolisticSubmenu(project: string): void {
  const proj = tryGetProject(project);
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildHolisticSubmenuPlan(project, proj.holisticReview ?? DEFAULT_HOLISTIC_REVIEW, resolveGardenRunner()));
}

export function runColorSubmenu(project: string): void {
  const proj = tryGetProject(project);
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildEnumSubmenuPlan(project, "logColor", `Log color for ${project}`, [...ASSIGNABLE_LOG_COLOR_KEYS], proj.logColor, resolveGardenRunner(), "unset — auto-assign"));
}

export function runProjectModelSubmenu(project: string): void {
  const proj = tryGetProject(project);
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  const { models } = projectBuilderChoices(proj, loadConfig());
  runMenu(buildProjectModelSubmenuPlan(project, models, proj.model, resolveGardenRunner()));
}

export function runProjectEffortSubmenu(project: string): void {
  const proj = tryGetProject(project);
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  const { efforts } = projectBuilderChoices(proj, loadConfig());
  runMenu(buildProjectEffortSubmenuPlan(project, efforts, proj.effort, resolveGardenRunner()));
}

// ---- mutating dispatch (set -> present -> refresh -> re-open) -------------

const SETTABLE = new Set<string>(SETTABLE_KEYS);

export function applyConfigSetFromMenu(project: string, key: string, value: string): void {
  if (!tryGetProject(project)) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  if (!SETTABLE.has(key)) { tmuxDisplay(`Cannot set '${key}' from the menu.`); return; }
  try {
    const r = setProjectConfigKey(project, key as SettableKey, value);
    tmuxDisplay(r.message);
    r.notes?.forEach((n) => log.info("project-menu", n.trim(), { data: { project } }));
  } catch (err) {
    tmuxDisplay(err instanceof Error ? err.message : String(err));
    return;
  }
  try { refreshDashboard(); } catch { /* best effort */ }
  runProjectMenu(project);
}
