// Trellis vine picker (⌥⇧N hotkey). Uses tmux display-menu for the
// arrow-key + enter UX — no fzf dependency, works wherever tmux works.
//
// Three population states per WORKFLOWS.md "Hotkey: ⌥⇧n":
//   - Zero active trellises: a menu with [a] author / [n] scaffold /
//     [r] revive (last only when retired ones exist).
//   - One active trellis: skip the menu, plant immediately.
//   - Two or more: standard picker — one row per trellis.
//
// Each row's command shells out to `garden dashboard _trellis-plant
// <project> <name>` via the resolved garden runner. Action items
// shell out to similar internal subcommands. tmux display-menu is
// fire-and-forget; the spawned commands handle the actual work.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { log } from "./log.js";
import { newWorker } from "./workers.js";
import { resolveGardenRunner } from "./runner.js";
import { readDashState } from "./state.js";
import { shellEscape, tmuxDisplay } from "./tmux.js";
import {
  findTrellisFiles, validateTrellisPlant,
  type TrellisFileInfo,
} from "./trellis-tag.js";

// Menu item shape — the production caller renders these via tmux
// display-menu, but the helpers are pure so tests can construct + assert
// the menu without driving tmux.
export interface MenuItem {
  /** Visible label. May contain a leading "(N)" key shortcut for
   *  display-menu's quick-key feature. */
  label: string;
  /** Single-character key for tmux's quick-select; "" disables. */
  key: string;
  /** Shell command to run when the user presses Enter on this item.
   *  Already shell-escaped where needed. Empty string for separators. */
  command: string;
}

export interface PickerPlan {
  /** Title rendered above the menu (or empty for one-item / direct plant). */
  title: string;
  /** Menu items, in display order. Empty when the picker should plant
   *  immediately without prompting (single-active case). */
  items: MenuItem[];
  /** When non-null, the picker bypasses the menu and plants this trellis
   *  directly. The single-active short-circuit per spec. */
  directPlant?: { project: string; name: string };
}

// Build a picker plan for a project. Pure: takes the trellis list as
// input, returns the menu shape. Tests drive this directly without
// invoking tmux.
export function buildPickerPlan(
  projectName: string,
  trellises: TrellisFileInfo[],
  runner: string,
): PickerPlan {
  const active = trellises.filter(t => !t.retired);
  const retired = trellises.filter(t => t.retired);

  // Single-active short-circuit: plant immediately, no menu.
  if (active.length === 1) {
    return {
      title: "",
      items: [],
      directPlant: { project: projectName, name: active[0].name },
    };
  }

  // Empty-state: present the three actions.
  if (active.length === 0) {
    const items: MenuItem[] = [
      {
        label: "(a) Author a new trellis (default worker → trellis-author)",
        key: "a",
        command: shellCmdAuthor(runner, projectName),
      },
      {
        label: "(n) Scaffold an empty trellis",
        key: "n",
        command: shellCmdScaffold(runner, projectName),
      },
    ];
    if (retired.length > 0) {
      items.push({
        label: `(r) Revive a retired trellis (${retired.length})`,
        key: "r",
        command: shellCmdReviveSubmenu(runner, projectName),
      });
    }
    return {
      title: `No active trellises in ${projectName}`,
      items,
    };
  }

  // Standard multi-active picker. One row per trellis. Truncate the
  // summary so wide menus don't blow out the popup.
  const items: MenuItem[] = active.map((t, i) => ({
    // tmux display-menu's quick-key matches the first character of the
    // label (or the explicit key arg). Use the index-as-digit (1..9) for
    // quick selection plus the arrow-key fallback. After 9, fall through
    // to plain navigation.
    label: formatMenuLabel(t),
    key: i < 9 ? String(i + 1) : "",
    command: shellCmdPlant(runner, projectName, t.name),
  }));
  return {
    title: `Plant a trellis vine on ${projectName}`,
    items,
  };
}

const MAX_LABEL_WIDTH = 80;

function formatMenuLabel(t: TrellisFileInfo): string {
  const sentinelWarn = t.hasSentinel ? "" : " ⚠ no sentinel";
  const summary = t.summary === "—" ? "" : ` — ${t.summary}`;
  const raw = `${t.name}${summary}${sentinelWarn}`;
  if (raw.length <= MAX_LABEL_WIDTH) return raw;
  return raw.slice(0, MAX_LABEL_WIDTH - 1) + "…";
}

// --- Shell commands the menu items invoke ---------------------------------

function shellCmdPlant(runner: string, project: string, trellisName: string): string {
  return `${runner} dashboard _trellis-plant ${shellEscape(project)} ${shellEscape(trellisName)}`;
}

function shellCmdAuthor(runner: string, project: string): string {
  return `${runner} dashboard _trellis-plant-author ${shellEscape(project)}`;
}

function shellCmdScaffold(runner: string, project: string): string {
  // Use tmux command-prompt for the trellis name input, then dispatch
  // garden trellis new.
  const inner = `${runner} trellis new ${shellEscape(project)} %%`;
  return `command-prompt -p "Trellis name: " "run-shell ${shellEscape(inner)}"`;
}

function shellCmdReviveSubmenu(runner: string, project: string): string {
  return `${runner} dashboard _trellis-revive-submenu ${shellEscape(project)}`;
}

// --- Top-level picker entry point ----------------------------------------

// Spawned by the ⌥⇧N hotkey. Resolves the active project from dashboard
// state (or accepts an explicit project arg for non-hotkey paths), builds
// the plan, and drives tmux display-menu.
export function runTrellisPicker(explicitProject?: string): void {
  let projectName = explicitProject;
  if (!projectName) {
    const state = readDashState();
    if (!state.activeProject) {
      tmuxDisplay("No active project. Use ⌥1-⌥9 to select one first.");
      return;
    }
    projectName = state.activeProject;
  }
  const project = tryGetProject(projectName);
  if (!project) {
    tmuxDisplay(`Unknown project '${projectName}'.`);
    return;
  }

  const trellises = findTrellisFiles(projectName);
  const runner = resolveGardenRunner();
  const plan = buildPickerPlan(projectName, trellises, runner);

  // Single-active short-circuit: plant immediately, no popup.
  if (plan.directPlant) {
    plantVineFromPicker(plan.directPlant.project, plan.directPlant.name);
    return;
  }

  // Render the menu via tmux display-menu. -O closes the menu when its
  // quick-key matches; -T sets the title; positional args pair name+command.
  // -x C / -y C centers the popup on the active client.
  const menuArgs: string[] = [
    "display-menu",
    "-O",
    "-T", plan.title,
    "-x", "C",
    "-y", "C",
  ];
  for (const item of plan.items) {
    menuArgs.push(item.label, item.key, item.command);
  }
  try {
    execFileSync("tmux", menuArgs, { stdio: "ignore" });
  } catch (err) {
    log.warn("trellis-picker", "display-menu failed", {
      data: { error: String(err), project: projectName },
    });
  }
}

// Invoked by the [a] author empty-state action. Spawns a fresh
// default-workflow worker on the project, seeded with a one-line
// instruction asking it to invoke the trellis-author skill. The skill's
// description triggers on operator intent, so explicit instruction in
// the seed is the cleanest way to fire it.
export function spawnTrellisAuthor(projectName: string): void {
  if (!tryGetProject(projectName)) {
    tmuxDisplay(`Unknown project '${projectName}'.`);
    return;
  }
  const seed = [
    "[garden] Please invoke the `trellis-author` skill (.claude/skills/trellis-author/SKILL.md).",
    "",
    "I want to formalize a feature as a trellis. Walk me through the steps in the skill: scope sizing, the spine (title + sentinel + tag), the recommended sections (Intent / Surface / Behavior / Tests / Docs / Out of scope), and a self-review pass before saving.",
    "",
    "When the trellis is ready, scaffold it via `garden trellis new <project> <name>`, then commit it on main.",
  ].join("\n");

  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(
    seedsDir,
    `seed-trellis-author-${projectName}-${Date.now()}.txt`,
  );
  fs.writeFileSync(seedFile, seed);

  const newName = newWorker({
    projectName,
    seedMessageFile: seedFile,
  });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    tmuxDisplay(
      `Failed to spawn worker on '${projectName}'. Is the dashboard running?`,
    );
    return;
  }
  log.info("trellis-picker", "spawned trellis-author worker", {
    worker: newName, data: { project: projectName },
  });
}

// Sub-menu of retired trellises, shown when the operator picks [r] from
// the empty-state menu. Each item runs `garden trellis revive`.
export function runReviveSubmenu(projectName: string): void {
  const project = tryGetProject(projectName);
  if (!project) return;
  const retired = findTrellisFiles(projectName).filter(t => t.retired);
  if (retired.length === 0) {
    tmuxDisplay(`No retired trellises in '${projectName}'.`);
    return;
  }
  const runner = resolveGardenRunner();
  const menuArgs: string[] = [
    "display-menu",
    "-O",
    "-T", `Revive a retired trellis (${projectName})`,
    "-x", "C",
    "-y", "C",
  ];
  for (let i = 0; i < retired.length; i++) {
    const t = retired[i];
    menuArgs.push(
      `(${i < 9 ? i + 1 : ""}) ${t.name}`,
      i < 9 ? String(i + 1) : "",
      `${runner} trellis revive ${shellEscape(projectName)} ${shellEscape(t.name)}`,
    );
  }
  try {
    execFileSync("tmux", menuArgs, { stdio: "ignore" });
  } catch (err) {
    log.warn("trellis-picker", "revive submenu display-menu failed", {
      data: { error: String(err), project: projectName },
    });
  }
}

// --- Plant action --------------------------------------------------------

// Invoked from a menu selection (or directly via the single-active
// short-circuit). Runs validateTrellisPlant; spawns the vine via
// newWorker with a seed prompt.
export function plantVineFromPicker(projectName: string, trellisName: string): void {
  const project = tryGetProject(projectName);
  if (!project) {
    tmuxDisplay(`Unknown project '${projectName}'.`);
    return;
  }
  const result = validateTrellisPlant(projectName, trellisName);
  if (!result.ok) {
    tmuxDisplay(`Plant failed: ${result.error}`);
    return;
  }
  for (const w of result.warnings) {
    log.warn("trellis-picker", "plant warning", {
      data: { project: projectName, trellis: trellisName, warning: w },
    });
  }

  // Resolve max iterations from project config or default.
  const maxIter = project.maxTrellisIterations ?? 30;

  // Build the iteration-1 seed. Mirrors the CLI plant path's seed shape;
  // see commands/workers.ts for the canonical version. (Picker plants
  // omit operator-supplied --model — they take the workflow default.)
  const seed = buildIteration1Seed(trellisName, path.relative(project.path, result.info.path), maxIter);
  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(
    seedsDir,
    `seed-trellis-${projectName}-${trellisName}-${Date.now()}.txt`,
  );
  fs.writeFileSync(seedFile, seed);

  const newName = newWorker({
    projectName,
    workflow: "trellis",
    trellis: {
      name: trellisName,
      path: result.info.path,
      maxIterations: maxIter,
    },
    seedMessageFile: seedFile,
  });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    tmuxDisplay(
      `Failed to plant vine on '${projectName}'. Is the dashboard running?`,
    );
    return;
  }
  log.info("trellis-picker", "planted vine", {
    worker: newName, data: { project: projectName, trellis: trellisName },
  });
}

// Mirror of commands/workers.ts:buildIteration1Seed. Inlined here to
// avoid pulling commands/* into the dashboard module graph.
function buildIteration1Seed(
  trellisName: string,
  trellisRelative: string,
  maxIter: number,
): string {
  return [
    `[garden] You are a trellis vine bound to \`${trellisRelative}\`. Read it before editing — it is your source of truth.`,
    "",
    `Iteration 1 of ${maxIter}.`,
    "",
    "This is your first iteration. There is no prior drift list and no lessons file yet — you will create `.garden/trellis-lessons.md` as you work.",
    "",
    "Read the trellis end-to-end. It describes the feature's intent, surface, behavior, tests, and documentation. Implement what it says, in priority order. The reviewer will compare your work against the trellis after you push and emit one of:",
    "",
    "- `ALIGNED` — you matched every claim. The loop ends.",
    "- `DRIFT` — your work is mergeable but incomplete; the reviewer will list priority-ordered gaps for the next iteration.",
    "- `FAILED` — checks/rebase/rules failed and the reviewer couldn't fix them.",
    "- `FLAGGED` — the trellis itself is contradictory or impossible. The loop pauses pending operator action.",
    "",
    "After your changes, append a one-line entry to `.garden/trellis-lessons.md` describing what you tried and what you learned. Commit and push when ready.",
    "",
    "You may not edit the trellis. If it is wrong or impossible, push commits that reflect what it says — the reviewer will surface the contradiction as `FLAGGED` and the operator will decide whether to amend.",
  ].join("\n");
}
