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
import { deriveCrew } from "./crew.js";
import { ASSIGNABLE_LOG_COLOR_KEYS } from "../log-palette.js";
import { setProjectConfigKey, SETTABLE_KEYS, type SettableKey } from "./project-config-mutate.js";
import { listBranches, resolveBaseBranch } from "./git.js";
import { log } from "./log.js";

const NOT_SET = "(not set)";
const trunc = (s: string, n = 28): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// ---- pure plan builders --------------------------------------------------

export interface ProjectMenuView {
  project: string;
  runner: string;
  base: string;
  crew: string;
  ciGate: boolean;
  holistic: string;
  logColor: string;
  checks: string;
  postMerge: string;
}

export function buildProjectMenuPlan(v: ProjectMenuView): MenuSpec {
  const p = shellEscape(v.project);
  const g = v.runner;
  const sub = (name: string) => `${g} dashboard ${name} ${p}`;
  const rows: MenuRow[] = [
    { label: `(1) base branch      ${v.base}`, key: "1", run: sub("_config-branch-submenu") },
    { label: `(2) crew             ${v.crew}`, key: "2", run: `${g} dashboard _crew-picker ${p}` },
    { label: `(3) CI gate          ${v.ciGate ? "on" : "off"}`, key: "3", run: `${g} dashboard _config-set ${p} requireCiSuccess ${v.ciGate ? "false" : "true"}` },
    { label: `(4) holistic review  ${v.holistic}`, key: "4", run: sub("_config-holistic-submenu") },
    { label: `(5) log color        ${v.logColor}`, key: "5", run: sub("_config-color-submenu") },
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

function projectMenuView(name: string, project: ProjectConfig, config: GardenConfig): ProjectMenuView {
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
