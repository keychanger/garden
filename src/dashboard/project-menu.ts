// The ⌥, project config menu: inspect + set a project's configuration. Every
// row shows the current value inline, so the menu doubles as the inspector.
// Rows dispatch a submenu, a toggle, or `_config-set <p> <key> <value>` — all
// routed through the shared setProjectConfigKey / setProjectRoleDim mutators
// (dashboard/project-config-mutate.ts), so the menu and the `garden config` CLI
// share one writer and one set of validation. Free-form / rarely-touched values
// (checks, post-merge, iteration caps) are edited via the (e) config.yml editor;
// checks + post-merge are surfaced in the title so they are still visible.
//
// Plan builders are pure (a view/data object -> MenuSpec) and tested; each
// mutating handler re-opens the menu (form feel) after refreshing the pane.
import { execFileSync } from "node:child_process";
import { loadConfig, tryGetProject, CONFIG_PATH, type GardenConfig, type ProjectConfig } from "../config.js";
import { readDashState } from "./state.js";
import { resolveGardenRunner } from "./runner.js";
import { shellEscape, tmuxDisplay, tmuxDoubleQuote } from "./tmux.js";
import { runMenu, type MenuSpec, type MenuRow } from "./menu.js";
import { refreshDashboard } from "./header.js";
import { deriveCrew } from "./crew.js";
import { resolveReviewRole, type ReviewRole } from "./roles.js";
import { harnessNames } from "./harness/core.js";
import { ASSIGNABLE_LOG_COLOR_KEYS } from "../log-palette.js";
import {
  setProjectConfigKey, setProjectRoleDim, SETTABLE_KEYS, type SettableKey, REVIEW_ROLE_KEYS,
} from "./project-config-mutate.js";
import { listBranches } from "./git.js";
import { log } from "./log.js";

const NOT_SET = "(not set)";
const trunc = (s: string, n = 28): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// ---- pure plan builders --------------------------------------------------

export interface ProjectMenuView {
  project: string;
  runner: string;
  base: string;
  crew: string;
  reviewer: string;
  resolver: string;
  ciFix: string;
  ciGate: boolean;
  holistic: string;
  profile: string;
  provider: string;
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
    { label: `(3) roles            reviewer=${v.reviewer} resolver=${v.resolver} ci-fix=${v.ciFix}`, key: "3", run: sub("_config-role-submenu") },
    { label: `(4) CI gate          ${v.ciGate ? "on" : "off"}`, key: "4", run: `${g} dashboard _config-set ${p} requireCiSuccess ${v.ciGate ? "false" : "true"}` },
    { label: `(5) holistic review  ${v.holistic}`, key: "5", run: sub("_config-holistic-submenu") },
    { label: `(6) claude profile   ${v.profile}`, key: "6", run: sub("_config-profile-submenu") },
    { label: `(7) provider         ${v.provider}`, key: "7", run: sub("_config-provider-submenu") },
    { label: `(8) log color        ${v.logColor}`, key: "8", run: sub("_config-color-submenu") },
    { sep: true, label: "" },
    { label: "(e) edit config.yml (checks, post-merge, sandbox, iteration caps…)", key: "e", run: `${g} dashboard _config-edit` },
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

// The review-role submenu: reviewer / resolver / ci-fix, each showing its
// resolved harness and opening the harness submenu.
export function buildRoleSubmenuPlan(project: string, roles: { reviewer: string; resolver: string; ciFix: string }, runner: string): MenuSpec {
  const p = shellEscape(project);
  return {
    title: `Review roles for ${project}`,
    rows: [
      { label: `(1) reviewer   ${roles.reviewer}`, key: "1", run: `${runner} dashboard _config-role-harness ${p} reviewer` },
      { label: `(2) resolver   ${roles.resolver}`, key: "2", run: `${runner} dashboard _config-role-harness ${p} resolver` },
      { label: `(3) ci-fix     ${roles.ciFix}`, key: "3", run: `${runner} dashboard _config-role-harness ${p} ci-fix` },
    ],
  };
}

export function buildRoleHarnessSubmenuPlan(project: string, roleArg: string, harnesses: string[], current: string, runner: string): MenuSpec {
  const p = shellEscape(project);
  const rows: MenuRow[] = harnesses.map((h, i) => ({
    label: h === current ? `${h}  ✓` : h,
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _config-role-set ${p} ${roleArg} ${shellEscape(h)}`,
  }));
  rows.push({ label: "(0) unset — default (claude-code + Opus)", key: "0", run: `${runner} dashboard _config-role-set ${p} ${roleArg} ${shellEscape("")}` });
  return { title: `${roleArg} harness for ${project}`, rows };
}

export function buildHolisticSubmenuPlan(project: string, current: string, runner: string): MenuSpec {
  return buildEnumSubmenuPlan(project, "holisticReview", `Holistic review for ${project}`, ["off", "shadow", "fix"], current, runner, "unset — default (off)");
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

function roleHarness(project: ProjectConfig, config: GardenConfig, role: ReviewRole): string {
  return resolveReviewRole(project, "default", role, config).harness;
}

function projectMenuView(name: string, project: ProjectConfig, config: GardenConfig): ProjectMenuView {
  return {
    project: name,
    runner: resolveGardenRunner(),
    base: project.baseBranch ?? NOT_SET,
    crew: deriveCrew(project, config) ?? "custom",
    reviewer: roleHarness(project, config, "reviewer"),
    resolver: roleHarness(project, config, "resolver"),
    ciFix: roleHarness(project, config, "ciFix"),
    ciGate: project.requireCiSuccess ?? true,
    holistic: project.holisticReview ?? "off",
    profile: project.claudeProfile ?? NOT_SET,
    provider: project.provider ?? NOT_SET,
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

export function runRoleSubmenu(project: string): void {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildRoleSubmenuPlan(project, {
    reviewer: roleHarness(proj, config, "reviewer"),
    resolver: roleHarness(proj, config, "resolver"),
    ciFix: roleHarness(proj, config, "ciFix"),
  }, resolveGardenRunner()));
}

export function runRoleHarnessSubmenu(project: string, roleArg: string): void {
  const roleKey = REVIEW_ROLE_KEYS[roleArg];
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj || !roleKey) { tmuxDisplay(`Unknown project/role.`); return; }
  runMenu(buildRoleHarnessSubmenuPlan(project, roleArg, harnessNames(), roleHarness(proj, config, roleKey), resolveGardenRunner()));
}

export function runHolisticSubmenu(project: string): void {
  const proj = tryGetProject(project);
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildHolisticSubmenuPlan(project, proj.holisticReview ?? "off", resolveGardenRunner()));
}

export function runProfileSubmenu(project: string): void {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildEnumSubmenuPlan(project, "claudeProfile", `Claude profile for ${project}`, Object.keys(config.claudeProfiles ?? {}), proj.claudeProfile, resolveGardenRunner(), "unset — personal Max plan"));
}

export function runProviderSubmenu(project: string): void {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildEnumSubmenuPlan(project, "provider", `Provider for ${project}`, Object.keys(config.providers ?? {}), proj.provider, resolveGardenRunner(), "unset — first-party Anthropic"));
}

export function runColorSubmenu(project: string): void {
  const proj = tryGetProject(project);
  if (!proj) { tmuxDisplay(`Unknown project '${project}'.`); return; }
  runMenu(buildEnumSubmenuPlan(project, "logColor", `Log color for ${project}`, [...ASSIGNABLE_LOG_COLOR_KEYS], proj.logColor, resolveGardenRunner(), "unset — auto-assign"));
}

export function openConfigEditor(): void {
  const editor = process.env.EDITOR || "vi";
  try {
    execFileSync("tmux", ["display-popup", "-E", "-w", "90%", "-h", "90%", `${editor} ${shellEscape(CONFIG_PATH)}`], { stdio: "ignore" });
  } catch (err) {
    tmuxDisplay(`Could not open config.yml: ${err instanceof Error ? err.message : String(err)}`);
  }
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

export function applyRoleSetFromMenu(project: string, roleArg: string, value: string): void {
  const roleKey = REVIEW_ROLE_KEYS[roleArg];
  if (!tryGetProject(project) || !roleKey) { tmuxDisplay(`Unknown project/role.`); return; }
  try {
    const r = setProjectRoleDim(project, roleArg, roleKey, "harness", value);
    tmuxDisplay(r.message);
    r.notes?.forEach((n) => log.info("project-menu", n.trim(), { data: { project } }));
  } catch (err) {
    tmuxDisplay(err instanceof Error ? err.message : String(err));
    return;
  }
  try { refreshDashboard(); } catch { /* best effort */ }
  runRoleSubmenu(project);
}
