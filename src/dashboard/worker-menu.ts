// The ⌥i worker menu: inspect and act on the focused worker. One card that
// surfaces the existing worker verbs (hold/bounce/kick/pause/kill/show-review)
// AND the live-changeable settings the operator asked for:
//   - base branch: live — the poller reads entry.baseBranch fresh each cycle,
//     so a change re-targets the next review/merge (no respawn).
//   - review crew: live — resolveReviewRole layers entry.crew's review harness
//     ahead of project.roles, applied at the next review launch.
//   - model: needs a restart (the agent pins it at launch), so the model rows
//     set + bounce.
//
// The plan builders are pure (a view/data object -> MenuSpec) so tests assert
// them without tmux. Each config selection carries <project> <worker> EXPLICITLY
// through the dispatch chain, so a focus change mid-menu can never retarget a
// write. Identity/status facts ride the menu TITLE (tmux menus have no info
// rows — see menu.ts).
import { readDashState } from "./state.js";
import { tryGetProject, loadConfig } from "../config.js";
import { getWorkers, updateWorkerFields, type WorkerEntry } from "./registry.js";
import { resolveGardenRunner } from "./runner.js";
import { shellEscape, tmuxDisplay, tmuxDoubleQuote } from "./tmux.js";
import { runMenu, type MenuSpec, type MenuRow } from "./menu.js";
import { refreshDashboard } from "./header.js";
import { parseWorkerSuffix } from "./window-names.js";
import { resolveReviewRole } from "./roles.js";
import { reviewerMembers, crewNameFor } from "./crew.js";
import { listBranches, branchExistsOnOrigin } from "./git.js";
import { bounceWorker } from "./workers.js";
import { log } from "./log.js";

const DEFAULT_LABEL = "(default)";
// Common worker models offered directly; anything else via the command-prompt
// row (a concrete id or another alias). Kept small — these are the everyday
// choices; the prompt covers the long tail.
const COMMON_MODELS = ["opus", "sonnet", "haiku"];

// The display + dispatch inputs a worker card needs, pre-resolved so the plan
// builder stays pure.
export interface WorkerMenuView {
  project: string;
  worker: string;
  runner: string;
  state: string;
  base: string;      // entry.baseBranch, or DEFAULT_LABEL
  model: string;     // entry.model / trellis.workerModel, or DEFAULT_LABEL
  reviewer: string;  // current resolved reviewer harness
}

// Pure: the top-level worker card. Identity in the title; action rows, then the
// live config rows, then kill.
export function buildWorkerMenuPlan(v: WorkerMenuView): MenuSpec {
  const w = shellEscape(v.worker);
  const pw = `${shellEscape(v.project)} ${w}`;
  const g = v.runner;
  const reviewShell = `${g} review ${w} 2>&1; printf '\\n[Enter to close] '; read _`;
  return {
    title: `Worker ${v.worker} (${v.project}) · ${v.state} · base ${v.base} · model ${v.model} · reviewer ${v.reviewer}`,
    rows: [
      { label: "(e) hold / resume", key: "e", run: `${g} dashboard _hold-worker` },
      { label: "(b) bounce", key: "b", run: `${g} dashboard _bounce` },
      { label: "(k) kick review", key: "k", run: `${g} kick ${w}` },
      { label: "(u) pause auto-continue", key: "u", run: `${g} pause ${w}` },
      { label: "(U) resume auto-continue", run: `${g} resume ${w}` },
      { label: "(v) show last review", key: "v", tmux: `display-popup -E -w 90% -h 90% ${tmuxDoubleQuote(reviewShell)}` },
      { sep: true, label: "" },
      { label: `(1) base branch: ${v.base}`, key: "1", run: `${g} dashboard _worker-branch-submenu ${pw}` },
      { label: `(2) reviewer: ${v.reviewer}`, key: "2", run: `${g} dashboard _worker-crew-submenu ${pw}` },
      { label: `(3) model: ${v.model}`, key: "3", run: `${g} dashboard _worker-model-submenu ${pw}` },
      { sep: true, label: "" },
      { label: "(x) kill…", key: "x", run: `${g} dashboard _worker-kill-confirm ${pw}` },
    ],
  };
}

// Pure: the base-branch submenu. Recent branches (live change), plus unset.
export function buildWorkerBranchSubmenuPlan(
  project: string, worker: string, branches: string[], currentBase: string | undefined, runner: string,
): MenuSpec {
  const pw = `${shellEscape(project)} ${shellEscape(worker)}`;
  const rows = branches.map((b, i) => ({
    label: b === currentBase ? `${b}  ✓` : b,
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _worker-set ${pw} baseBranch ${shellEscape(b)}`,
  }));
  rows.push({ label: "(0) unset — follow the checkout", key: "0", run: `${runner} dashboard _worker-set ${pw} baseBranch ${shellEscape("")}` });
  return { title: `Base branch for ${worker} (applies to next review/merge)`, rows };
}

// Pure: the reviewer submenu. Each reviewer member maps to the crew that pairs
// the worker's CURRENT build member with that reviewer (crewNameFor), so
// entry.crew stays coherent; plus an unset row (project-default reviewer).
export function buildWorkerCrewSubmenuPlan(
  project: string, worker: string, members: { name: string; harness: string }[],
  entryHarness: string | undefined, provider: string | undefined, currentReviewer: string, runner: string,
): MenuSpec {
  const pw = `${shellEscape(project)} ${shellEscape(worker)}`;
  const rows = members.map((m, i) => {
    const crew = crewNameFor(entryHarness, provider, m.harness);
    return {
      label: m.harness === currentReviewer ? `${m.name}  ✓` : m.name,
      key: i < 9 ? String(i + 1) : "",
      run: `${runner} dashboard _worker-set ${pw} crew ${shellEscape(crew)}`,
    };
  });
  rows.push({ label: "(0) unset — project default reviewer", key: "0", run: `${runner} dashboard _worker-set ${pw} crew ${shellEscape("")}` });
  return { title: `Reviewer for ${worker} (applies at next review)`, rows };
}

// Pure: the model submenu. Common models + a command-prompt for a custom id +
// clear. Each SETS AND BOUNCES (the agent pins the model at launch).
export function buildWorkerModelSubmenuPlan(project: string, worker: string, currentModel: string, runner: string): MenuSpec {
  const pw = `${shellEscape(project)} ${shellEscape(worker)}`;
  const rows: MenuRow[] = COMMON_MODELS.map((m, i) => ({
    label: m === currentModel ? `${m}  ✓` : m,
    key: String(i + 1),
    run: `${runner} dashboard _worker-set-bounce ${pw} model ${shellEscape(m)}`,
  }));
  rows.push({ label: "(c) custom model id…", key: "c", tmux: `command-prompt -p "Model (sets + bounces): " ${tmuxDoubleQuote(`run-shell ${tmuxDoubleQuote(`${runner} dashboard _worker-set-bounce ${pw} model %%`)}`)}` });
  rows.push({ label: "(0) clear — account default", key: "0", run: `${runner} dashboard _worker-set-bounce ${pw} model ${shellEscape("")}` });
  return { title: `Model for ${worker} (sets + bounces to apply)`, rows };
}

// Pure: the kill confirmation. The menu is inherently focused-scoped, so the
// yes row reuses the focused _kill-pane.
export function buildWorkerKillConfirmPlan(project: string, worker: string, runner: string): MenuSpec {
  const pw = `${shellEscape(project)} ${shellEscape(worker)}`;
  return {
    title: `Kill worker ${worker}? This ends its session.`,
    rows: [
      { label: `(y) yes, kill ${worker}`, key: "y", run: `${runner} dashboard _kill-pane` },
      { label: "(n) cancel", key: "n", run: `${runner} dashboard _worker-menu ${pw}` },
    ],
  };
}

// Resolve the target worker: an explicit <project> <worker> (re-open after a
// set), else the dashboard's focused worker. Returns null (with an operator
// message) when there is no worker to act on.
function resolveTarget(explicitProject?: string, explicitWorker?: string): { project: string; worker: string; entry: WorkerEntry } | null {
  let project = explicitProject;
  let worker = explicitWorker;
  if (!project || !worker) {
    const state = readDashState();
    if (state.activePaneType !== "worker" || !state.activeProject || !state.activeWindowName) {
      tmuxDisplay("No worker focused. Use ⌥w or ⌥]/⌥[ to focus one first.");
      return null;
    }
    project = state.activeProject;
    worker = parseWorkerSuffix(state.activeWindowName) ?? undefined;
  }
  if (!project || !worker) {
    tmuxDisplay("Could not identify the focused worker.");
    return null;
  }
  const entry = getWorkers(project).find(e => e.name === worker);
  if (!entry) {
    tmuxDisplay(`Unknown worker '${worker}' in '${project}'.`);
    return null;
  }
  return { project, worker, entry };
}

export function runWorkerMenu(explicitProject?: string, explicitWorker?: string): void {
  const t = resolveTarget(explicitProject, explicitWorker);
  if (!t) return;
  const proj = tryGetProject(t.project);
  const reviewer = proj
    ? resolveReviewRole(proj, t.entry.workflow ?? "default", "reviewer", undefined, t.entry).harness
    : "claude-code";
  runMenu(buildWorkerMenuPlan({
    project: t.project,
    worker: t.worker,
    runner: resolveGardenRunner(),
    state: t.entry.prState ?? t.entry.agentStatus ?? "ready",
    base: t.entry.baseBranch ?? DEFAULT_LABEL,
    model: t.entry.model ?? t.entry.trellis?.workerModel ?? DEFAULT_LABEL,
    reviewer,
  }));
}

export function runWorkerBranchSubmenu(project: string, worker: string): void {
  const t = resolveTarget(project, worker);
  if (!t) return;
  const proj = tryGetProject(project);
  const branches = proj ? listBranches(proj.path) : [];
  runMenu(buildWorkerBranchSubmenuPlan(project, worker, branches, t.entry.baseBranch, resolveGardenRunner()));
}

export function runWorkerCrewSubmenu(project: string, worker: string): void {
  const t = resolveTarget(project, worker);
  if (!t) return;
  const proj = tryGetProject(project);
  const config = loadConfig();
  const reviewer = proj
    ? resolveReviewRole(proj, t.entry.workflow ?? "default", "reviewer", config, t.entry).harness
    : "claude-code";
  runMenu(buildWorkerCrewSubmenuPlan(
    project, worker, reviewerMembers(config), t.entry.harness, proj?.provider, reviewer, resolveGardenRunner(),
  ));
}

export function runWorkerModelSubmenu(project: string, worker: string): void {
  const t = resolveTarget(project, worker);
  if (!t) return;
  const current = t.entry.model ?? t.entry.trellis?.workerModel ?? DEFAULT_LABEL;
  runMenu(buildWorkerModelSubmenuPlan(project, worker, current, resolveGardenRunner()));
}

export function runWorkerKillConfirm(project: string, worker: string): void {
  const t = resolveTarget(project, worker);
  if (!t) return;
  runMenu(buildWorkerKillConfirmPlan(project, worker, resolveGardenRunner()));
}

const WORKER_SET_FIELDS = new Set(["baseBranch", "model", "crew"]);

// _worker-set <project> <worker> <field> <value>: write a live registry field,
// re-bake the pane, and re-open the worker menu (form feel). An empty value
// clears the field (the "unset" rows). baseBranch soft-warns if the branch
// isn't on origin — the operator chose it; the next merge is when it must exist.
export function applyWorkerSet(project: string, worker: string, field: string, value: string): void {
  if (!WORKER_SET_FIELDS.has(field)) {
    tmuxDisplay(`Cannot set '${field}' on a worker.`);
    return;
  }
  const t = resolveTarget(project, worker);
  if (!t) return;
  const clearing = value === "";
  updateWorkerFields(project, worker, { [field]: clearing ? undefined : value });
  if (field === "baseBranch" && !clearing) {
    const proj = tryGetProject(project);
    if (proj && !branchExistsOnOrigin(proj.path, value)) {
      tmuxDisplay(`Set base ${value} for ${worker} — note: not on origin yet, publish it before the next merge.`);
    } else {
      tmuxDisplay(`${worker}: base branch ${clearing ? "unset" : "→ " + value}.`);
    }
  } else {
    tmuxDisplay(`${worker}: ${field} ${clearing ? "unset" : "→ " + value}.`);
  }
  log.info("worker-menu", "set worker field", { worker, data: { project, field, value: clearing ? "(unset)" : value } });
  try { refreshDashboard(); } catch { /* best effort */ }
  runWorkerMenu(project, worker);
}

// _worker-set-bounce <project> <worker> model <value>: set the model, then
// bounce so the agent relaunches with it (the model pins at launch).
export function applyWorkerSetBounce(project: string, worker: string, field: string, value: string): void {
  if (field !== "model") {
    tmuxDisplay(`_worker-set-bounce only handles model (got '${field}').`);
    return;
  }
  const t = resolveTarget(project, worker);
  if (!t) return;
  const clearing = value === "";
  updateWorkerFields(project, worker, { model: clearing ? undefined : value });
  try {
    bounceWorker(project, worker);
    tmuxDisplay(`${worker}: model ${clearing ? "cleared" : "→ " + value}, bounced.`);
  } catch (err) {
    tmuxDisplay(`Set model but bounce failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  log.info("worker-menu", "set worker model + bounce", { worker, data: { project, value: clearing ? "(cleared)" : value } });
}
