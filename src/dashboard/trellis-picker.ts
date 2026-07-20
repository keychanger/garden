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
import path from "node:path";
import fs from "node:fs";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { buildGrowIteration1Seed } from "./grow-continue.js";
import { buildBotanistSeed } from "./botanist-prompts.js";
import { log } from "./log.js";
import { newWorker } from "./workers.js";
import { resolveGardenRunner } from "./runner.js";
import { readDashState } from "./state.js";
import { shellEscape, tmuxDisplay, menuRunShell } from "./tmux.js";
import { runMenu, type MenuSpec, type MenuRow } from "./menu.js";
import { loadConfig, type GardenConfig, type ProjectConfig } from "../config.js";
import { listCrews, listMembers, findMember, getCrew, projectWorkerMemberName } from "./crew.js";
import { codexModels, CODEX_EFFORT_LEVELS } from "./harness/codex-models.js";
import { listBranches } from "./git.js";
import { WORKER_EFFORT_LEVELS } from "./create.js";
import { readSpawnDraft, writeSpawnDraft, consumeSpawnDraft, type SpawnDraftPatch } from "./spawn-draft.js";
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
//
// A display-menu item's command is parsed by tmux as a TMUX command, not a
// shell command — so a bare `${runner} …` fails with "unknown command:
// <node>". menuRunShell wraps it in `run-shell`. The command-prompt helpers
// (scaffold / grow) are already valid tmux commands and are not wrapped.

function shellCmdPlant(runner: string, project: string, trellisName: string): string {
  return menuRunShell(`${runner} dashboard _trellis-plant ${shellEscape(project)} ${shellEscape(trellisName)}`);
}

function shellCmdAuthor(runner: string, project: string): string {
  return menuRunShell(`${runner} dashboard _trellis-plant-author ${shellEscape(project)}`);
}

function shellCmdScaffold(runner: string, project: string): string {
  // Use tmux command-prompt for the trellis name input, then dispatch
  // garden trellis new. command-prompt is a tmux command — no run-shell wrap.
  const inner = `${runner} trellis new ${shellEscape(project)} %%`;
  return `command-prompt -p "Trellis name: " "run-shell ${shellEscape(inner)}"`;
}

function shellCmdReviveSubmenu(runner: string, project: string): string {
  return menuRunShell(`${runner} dashboard _trellis-revive-submenu ${shellEscape(project)}`);
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

  runMenu({ title: plan.title, rows: plan.items.map(i => ({ label: i.label, key: i.key, tmux: i.command })) });
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
  runMenu({
    title: `Revive a retired trellis (${projectName})`,
    rows: retired.map((t, i) => ({
      label: `(${i < 9 ? i + 1 : ""}) ${t.name}`,
      key: i < 9 ? String(i + 1) : "",
      tmux: menuRunShell(`${runner} trellis revive ${shellEscape(projectName)} ${shellEscape(t.name)}`),
    })),
  });
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

  // A staged base override applies to any workflow (crew is default-only, so a
  // vine consumes the draft but ignores its crew half).
  const draft = consumeSpawnDraft(projectName);
  const newName = newWorker({
    projectName,
    workflow: "trellis",
    trellis: {
      name: trellisName,
      path: result.info.path,
      maxIterations: maxIter,
    },
    seedMessageFile: seedFile,
    ...(draft.base ? { base: draft.base } : {}),
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

// ============================================================================
// Workflow picker (⌥⇧N hotkey)
// ============================================================================
//
// Top-level menu choosing among the registered workflows. Trellis was
// reachable from ⌥⇧N when it was the only configurable workflow; with grow
// shipping alongside it, ⌥⇧N now opens this 3-row menu (default / trellis /
// grow). The trellis row dispatches the existing trellis picker as a
// submenu; the default row degenerates to ⌥n; the grow row prompts via
// tmux command-prompt for a single-line task description and dispatches
// `_grow-plant`.
//
// The grow command-prompt input is single-line and shell-substituted via
// tmux's `%%` placeholder, which means seeds containing single quotes or
// other shell metacharacters can break the dispatch. Operators with
// multi-line or special-character seeds use the CLI:
// `garden workers new --workflow grow --seed-file <path>`.

// Suggested models for a claude-code build member — the everyday Anthropic
// aliases (fable included, per the "fable ultracode" ergonomic). Opaque
// strings passed to `--model`; the CLI `workers new --model <id>` covers any
// exotic id, exactly as base/crew keep their fixed lists.
const COMPOSER_MODELS = ["opus", "sonnet", "haiku", "fable"];

// The claude-code effort rungs: the four `--effort` levels plus "ultra" — the
// top rung the consumer maps to the ultracode preset.
const COMPOSER_EFFORTS = [...WORKER_EFFORT_LEVELS, "ultra"];

const CODEX_HARNESS = "codex";
const DEFAULT_MEMBER_HARNESS = "claude-code";

// The build member the composer is currently configuring — the answer to "who
// builds this worker". Precedence mirrors newWorker's own harness resolution:
// the explicitly staged member wins, else a staged crew's worker half, else the
// project default (its `harness` key or its bound crew). This is what makes the
// model and effort dims correct rather than always-Anthropic: a project bound to
// an all-claude crew offers Anthropic aliases, and staging `codex` re-populates
// both submenus from Codex's catalog.
export function effectiveBuildMember(
  project: Pick<ProjectConfig, "harness" | "provider" | "crew">,
  draft: SpawnDraftPatch,
  config: GardenConfig,
): string {
  if (draft.member) return draft.member;
  if (draft.crew) {
    const crew = getCrew(draft.crew, config);
    if (crew) return crew.worker.name;
  }
  return projectWorkerMemberName(project, config);
}

// The harness a member builds with. An unknown member (a crew or config naming
// something since removed) resolves to the default rather than erroring — the
// composer is a menu, and newWorker validates the harness for real at spawn.
export function memberHarness(member: string, config: GardenConfig): string {
  return findMember(member, config)?.harness ?? DEFAULT_MEMBER_HARNESS;
}

// The provider backend a member builds against, if any. A harness member
// (claude / codex) carries none — it runs first-party.
export function memberProvider(member: string, config: GardenConfig): string | undefined {
  return findMember(member, config)?.provider;
}

// The model aliases a provider actually serves — the keys of its `modelMap`,
// which is the whole set of names that resolve to a real backend model for it.
// Offering the full Anthropic list would be wrong in both directions: an
// unmapped alias reaches the provider as a literal it does not know, and the
// provider may map only a subset (`haiku` alone). An empty/absent map means the
// provider serves whatever its endpoint defaults to, so the caller falls back.
export function providerModelAliases(provider: string, config: GardenConfig): string[] {
  const map = config.providers?.[provider]?.modelMap ?? {};
  return Object.entries(map).filter(([, v]) => v).map(([k]) => k);
}

// Model / effort vocabularies belong to the build MEMBER, not to garden: Codex
// names concrete slugs (gpt-5.6-sol) where Anthropic names aliases (opus), a
// provider serves only the aliases its modelMap defines, and Codex's reasoning
// rungs are its own `model_reasoning_effort` values. Offering one member's
// vocabulary while another builds is the bug this fixes.
export function composerModels(harness: string, providerAliases?: string[]): string[] {
  if (harness === CODEX_HARNESS) return codexModels();
  // A provider is reached through claude-code, so it shares the harness but
  // NOT the model vocabulary.
  if (providerAliases && providerAliases.length > 0) return providerAliases;
  return COMPOSER_MODELS;
}

export function composerEfforts(harness: string): string[] {
  return harness === CODEX_HARNESS ? CODEX_EFFORT_LEVELS : COMPOSER_EFFORTS;
}

// Map a consumed draft's model/effort onto newWorker options, in the target
// harness's dialect. On claude-code, "ultra" is the ultracode preset (max effort
// + dynamic workflows), so it becomes `ultracode: true` rather than an effort
// value; the other rungs pass through as `effort`. On codex, every rung —
// including its own genuine "ultra" reasoning level — is a plain
// `model_reasoning_effort` value, and ultracode has no analog, so the whole
// ladder passes through untranslated. Used by every consume path so the mapping
// lives in one place. `harness` absent = claude-code (the grow/botanist plant
// paths, which are claude-code-only workflows).
export function draftLaunchOpts(
  draft: SpawnDraftPatch,
  harness?: string,
): { model?: string; effort?: string; ultracode?: boolean } {
  const opts: { model?: string; effort?: string; ultracode?: boolean } = {};
  if (draft.model) opts.model = draft.model;
  if (harness === CODEX_HARNESS) {
    if (draft.effort) opts.effort = draft.effort;
  } else if (draft.effort === "ultra") {
    opts.ultracode = true;
  } else if (draft.effort) {
    opts.effort = draft.effort;
  }
  return opts;
}

// The override bracket for the composer title — reads like the spoken recipe:
// model and effort bare (sonnet · xhigh), crew and base labeled.
function draftBracket(draft: SpawnDraftPatch): string {
  const parts: string[] = [];
  if (draft.member) parts.push(draft.member);
  if (draft.model) parts.push(draft.model);
  if (draft.effort) parts.push(draft.effort);
  if (draft.crew) parts.push(`crew ${draft.crew}`);
  if (draft.base) parts.push(`base ${draft.base}`);
  return parts.length ? ` (${parts.join(" · ")})` : "";
}

// Build the workflow picker / spawn composer plan: the workflow rows, then the
// override rows (build member, model, effort, crew, base). The `default` row
// dispatches _compose-default (consumes the staged draft) — NOT _new-worker,
// which ⌥n keeps as the draft-free fast path. Pure: the draft is read by the
// caller and passed in.
export function buildWorkflowPickerPlan(
  projectName: string,
  runner: string,
  draft: SpawnDraftPatch = {},
): MenuSpec {
  const p = shellEscape(projectName);
  const rows: MenuRow[] = [
    { label: "(d) default — fast worker", key: "d", run: `${runner} dashboard _compose-default ${p}` },
    { label: "(o) botanist — design a doc, then hand off", key: "o", run: `${runner} dashboard _botanist-plant ${p}` },
    { label: "(t) trellis — pick a frozen design doc", key: "t", tmux: shellCmdTrellisPicker(runner, projectName) },
    { label: "(h) hoop — bounded iteration loop", key: "h", tmux: shellCmdGrowPlant(runner, projectName) },
    { sep: true, label: "" },
    { label: `(w) build…         [${draft.member ?? "default"}]`, key: "w", run: `${runner} dashboard _compose-member-submenu ${p}` },
    { label: `(m) model…         [${draft.model ?? "default"}]`, key: "m", run: `${runner} dashboard _compose-model-submenu ${p}` },
    { label: `(e) effort…        [${draft.effort ?? "default"}]`, key: "e", run: `${runner} dashboard _compose-effort-submenu ${p}` },
    { label: `(c) crew…          [${draft.crew ?? "default"}]`, key: "c", run: `${runner} dashboard _compose-crew-submenu ${p}` },
    { label: `(b) base branch…   [${draft.base ?? "default"}]`, key: "b", run: `${runner} dashboard _compose-base-submenu ${p}` },
  ];
  return { title: `New worker on ${projectName}${draftBracket(draft)}`, rows };
}

// Compose base/crew submenus: pick a value, stage it in the draft, re-open the
// composer. Pure builders (tests assert them). The crew list is filtered to
// all-harness worker members — a per-worker spawn has no provider path, so a
// provider-backed worker member (deepseek-*) is not offered.
export function buildComposeBaseSubmenuPlan(project: string, branches: string[], current: string | undefined, runner: string): MenuSpec {
  const p = shellEscape(project);
  const rows: MenuRow[] = branches.map((b, i) => ({
    label: b === current ? `${b}  ✓` : b,
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _spawn-draft ${p} base ${shellEscape(b)}`,
  }));
  rows.push({ label: "(0) clear — project default", key: "0", run: `${runner} dashboard _spawn-draft ${p} base ${shellEscape("")}` });
  return { title: `Base branch for the new worker on ${project}`, rows };
}

// Build member dim — who builds: `claude`, `codex`, any other registered
// harness, plus one row per configured provider (`deepseek` → claude-code
// against that backend). Staged as `member` and consumed as newWorker's
// harness+provider PAIR, which outranks a staged crew's worker half, so picking
// a builder here and a crew there means "this builder, that reviewer".
export function buildComposeMemberSubmenuPlan(project: string, members: string[], current: string | undefined, runner: string): MenuSpec {
  const p = shellEscape(project);
  const rows: MenuRow[] = members.map((m, i) => ({
    label: m === current ? `${m}  ✓` : m,
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _spawn-draft ${p} member ${shellEscape(m)}`,
  }));
  rows.push({ label: "(0) clear — project default", key: "0", run: `${runner} dashboard _spawn-draft ${p} member ${shellEscape("")}` });
  return { title: `Build agent for the new worker on ${project}`, rows };
}

export function buildComposeCrewSubmenuPlan(project: string, crews: string[], current: string | undefined, runner: string): MenuSpec {
  const p = shellEscape(project);
  const rows: MenuRow[] = crews.map((c, i) => ({
    label: c === current ? `${c}  ✓` : c,
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _spawn-draft ${p} crew ${shellEscape(c)}`,
  }));
  rows.push({ label: "(0) clear — project default crew", key: "0", run: `${runner} dashboard _spawn-draft ${p} crew ${shellEscape("")}` });
  return { title: `Crew for the new worker on ${project}`, rows };
}

// Model dim (default/grow workers; trellis resolves its own). Fixed alias list
// — the CLI covers exotic ids.
export function buildComposeModelSubmenuPlan(project: string, models: string[], current: string | undefined, runner: string): MenuSpec {
  const p = shellEscape(project);
  const rows: MenuRow[] = models.map((m, i) => ({
    label: m === current ? `${m}  ✓` : m,
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _spawn-draft ${p} model ${shellEscape(m)}`,
  }));
  rows.push({ label: "(0) clear — account default", key: "0", run: `${runner} dashboard _spawn-draft ${p} model ${shellEscape("")}` });
  return { title: `Model for the new worker on ${project}`, rows };
}

// Effort dim (default/grow workers). The four `--effort` rungs plus "ultra" —
// the sentinel the consumer maps to the ultracode preset (max effort + dynamic
// workflows). "ultra" carries its own descriptive suffix.
export function buildComposeEffortSubmenuPlan(project: string, efforts: string[], current: string | undefined, runner: string): MenuSpec {
  const p = shellEscape(project);
  const rows: MenuRow[] = efforts.map((e, i) => {
    const name = e === "ultra" ? "ultra — max effort + dynamic workflows" : e;
    return {
      label: e === current ? `${name}  ✓` : name,
      key: i < 9 ? String(i + 1) : "",
      run: `${runner} dashboard _spawn-draft ${p} effort ${shellEscape(e)}`,
    };
  });
  rows.push({ label: "(0) clear — account default", key: "0", run: `${runner} dashboard _spawn-draft ${p} effort ${shellEscape("")}` });
  return { title: `Effort for the new worker on ${project}`, rows };
}

// Spawned by the ⌥⇧N hotkey. Resolves the active project, builds the
// 3-row plan, and drives tmux display-menu.
export function runWorkflowPicker(explicitProject?: string): void {
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

  const runner = resolveGardenRunner();
  runMenu(buildWorkflowPickerPlan(projectName, runner, readSpawnDraft(projectName)));
}

// _compose-base-submenu / _compose-crew-submenu: stage a base/crew override.
export function runComposeBaseSubmenu(projectName: string): void {
  const project = tryGetProject(projectName);
  if (!project) { tmuxDisplay(`Unknown project '${projectName}'.`); return; }
  runMenu(buildComposeBaseSubmenuPlan(projectName, listBranches(project.path), readSpawnDraft(projectName).base, resolveGardenRunner()));
}

export function runComposeCrewSubmenu(projectName: string): void {
  if (!tryGetProject(projectName)) { tmuxDisplay(`Unknown project '${projectName}'.`); return; }
  // Only all-harness worker members — a per-worker spawn has no provider path.
  const crews = listCrews(loadConfig()).filter(c => !c.worker.provider).map(c => c.name);
  runMenu(buildComposeCrewSubmenuPlan(projectName, crews, readSpawnDraft(projectName).crew, resolveGardenRunner()));
}

export function runComposeMemberSubmenu(projectName: string): void {
  if (!tryGetProject(projectName)) { tmuxDisplay(`Unknown project '${projectName}'.`); return; }
  // Every member, provider-backed ones included — see
  // buildComposeMemberSubmenuPlan.
  const members = listMembers(loadConfig()).map(m => m.name);
  runMenu(buildComposeMemberSubmenuPlan(projectName, members, readSpawnDraft(projectName).member, resolveGardenRunner()));
}

// The model and effort submenus are populated for the draft's EFFECTIVE build
// member, so they always describe the agent that will actually run.
export function runComposeModelSubmenu(projectName: string): void {
  const project = tryGetProject(projectName);
  if (!project) { tmuxDisplay(`Unknown project '${projectName}'.`); return; }
  const draft = readSpawnDraft(projectName);
  const config = loadConfig();
  const member = effectiveBuildMember(project, draft, config);
  const provider = memberProvider(member, config);
  const models = composerModels(
    memberHarness(member, config),
    provider ? providerModelAliases(provider, config) : undefined,
  );
  runMenu(buildComposeModelSubmenuPlan(projectName, models, draft.model, resolveGardenRunner()));
}

export function runComposeEffortSubmenu(projectName: string): void {
  const project = tryGetProject(projectName);
  if (!project) { tmuxDisplay(`Unknown project '${projectName}'.`); return; }
  const draft = readSpawnDraft(projectName);
  const efforts = composerEfforts(draftBuildHarness(project, draft));
  runMenu(buildComposeEffortSubmenuPlan(projectName, efforts, draft.effort, resolveGardenRunner()));
}

// Launch opts for the claude-code-only workflows (grow, botanist). They cannot
// honor a build member — `--harness` is default-workflow-only — so a draft
// staged for a foreign harness would otherwise hand them that harness's model
// and effort while spawning claude: `--model gpt-5.6-sol` on a Claude worker.
// The dims are dropped rather than translated (there is no sensible mapping
// from a Codex slug to an Anthropic alias), leaving the account default.
export function claudeOnlyLaunchOpts(
  project: Pick<ProjectConfig, "harness" | "provider" | "crew">,
  draft: SpawnDraftPatch,
): { model?: string; effort?: string; ultracode?: boolean } {
  if (draftBuildHarness(project, draft) !== DEFAULT_MEMBER_HARNESS) return {};
  return draftLaunchOpts(draft);
}

// The harness a draft will build with, resolved through the member chain.
function draftBuildHarness(
  project: Pick<ProjectConfig, "harness" | "provider" | "crew">,
  draft: SpawnDraftPatch,
): string {
  const config = loadConfig();
  return memberHarness(effectiveBuildMember(project, draft, config), config);
}

// The (harness, provider) pair a draft will build with, as a comparable string.
// The staged model/effort are cleared when this changes rather than when the
// harness alone does: two provider members share the claude-code harness but
// not their model vocabularies (each serves only its own modelMap aliases), so
// keying the clear on harness would carry a DeepSeek-only alias onto a
// different backend that never mapped it.
function draftBuildPair(
  project: Pick<ProjectConfig, "harness" | "provider" | "crew">,
  draft: SpawnDraftPatch,
): string {
  const config = loadConfig();
  const member = effectiveBuildMember(project, draft, config);
  return `${memberHarness(member, config)}/${memberProvider(member, config) ?? ""}`;
}

// _spawn-draft <project> <field> <value>: stage a base/crew/member/model/effort
// override and re-open the composer (form feel). Empty value clears the field.
//
// Changing the BUILD member also clears any staged model and effort when the
// harness changes. Those two dims are named in the outgoing harness's
// vocabulary — `sonnet` and the ultracode `ultra` mean nothing to Codex, and
// `gpt-5.6-sol` means nothing to Claude — so carrying them across would stage a
// recipe that cannot run. Clearing drops both to the account default, which is
// always valid; the operator re-picks from the now-correct list.
export function stageSpawnDraft(projectName: string, field: string, value: string): void {
  if (field !== "base" && field !== "crew" && field !== "member" && field !== "model" && field !== "effort") {
    tmuxDisplay(`Unknown draft field '${field}'.`); return;
  }
  const patch: SpawnDraftPatch = { [field]: value };
  if (field === "member" || field === "crew") {
    const project = tryGetProject(projectName);
    if (project) {
      const draft = readSpawnDraft(projectName);
      const before = draftBuildPair(project, draft);
      const after = draftBuildPair(project, { ...draft, [field]: value });
      if (before !== after) { patch.model = ""; patch.effort = ""; }
    }
  }
  writeSpawnDraft(projectName, patch);
  runWorkflowPicker(projectName);
}

// _compose-default <project>: consume the staged draft and spawn a default
// worker with its base/crew overrides. Distinct from ⌥n's _new-worker.
export function composeDefaultFromPicker(projectName: string): void {
  const project = tryGetProject(projectName);
  if (!project) { tmuxDisplay(`Unknown project '${projectName}'.`); return; }
  const config = loadConfig();
  const draft = consumeSpawnDraft(projectName);
  // The staged member becomes `harness`, which newWorker treats as authoritative
  // over a crew's worker half — so staging both spawns this builder reviewed by
  // that crew's reviewer. The model/effort dialect follows the same harness.
  const member = effectiveBuildMember(project, draft, config);
  const harness = memberHarness(member, config);
  // A staged member is passed as its full pair: the harness AND the provider it
  // builds against. Passing only the harness would let the project's provider
  // leak back in, which is exactly the lie the build dim exists to prevent —
  // choosing `claude` on a provider-backed project must mean first-party.
  const memberOpts = draft.member
    ? {
        harness: memberHarness(draft.member, config),
        ...(memberProvider(draft.member, config) ? { provider: memberProvider(draft.member, config) } : {}),
      }
    : {};
  const newName = newWorker({
    projectName,
    ...(draft.base ? { base: draft.base } : {}),
    ...(draft.crew ? { crew: draft.crew } : {}),
    ...memberOpts,
    ...draftLaunchOpts(draft, harness),
  });
  if (!newName) {
    tmuxDisplay(`Failed to spawn worker on '${projectName}'. Is the dashboard running?`);
  }
}

// Invoked by `_grow-plant <project> <seed>` (the grow row of the workflow
// picker). Validates project + non-empty seed, resolves max iterations from
// project config (or default 5), writes the iter-1 seed file, and spawns
// the grow worker via newWorker. Mirrors plantVineFromPicker's shape.
export function plantGrowFromPicker(projectName: string, seed: string): void {
  const project = tryGetProject(projectName);
  if (!project) {
    tmuxDisplay(`Unknown project '${projectName}'.`);
    return;
  }
  const trimmed = seed.trim();
  if (!trimmed) {
    tmuxDisplay("Grow plant aborted: task description must be non-empty.");
    return;
  }

  const maxIter = project.maxGrowIterations ?? 5;

  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(
    seedsDir,
    `seed-grow-${projectName}-${Date.now()}.txt`,
  );
  fs.writeFileSync(seedFile, buildGrowIteration1Seed(trimmed, maxIter));

  const draft = consumeSpawnDraft(projectName);
  const newName = newWorker({
    projectName,
    workflow: "grow",
    grow: { seed: trimmed, maxIterations: maxIter },
    seedMessageFile: seedFile,
    ...(draft.base ? { base: draft.base } : {}),
    // Grow honors the model/effort dims (default-adjacent — entry.model +
    // ultracode apply); crew and build member are default-only and not consumed
    // here, so a foreign-harness draft drops both dims rather than handing
    // claude another harness's model.
    ...claudeOnlyLaunchOpts(project, draft),
  });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    tmuxDisplay(
      `Failed to plant grow worker on '${projectName}'. Is the dashboard running?`,
    );
    return;
  }
  log.info("workflow-picker", "planted grow worker", {
    worker: newName, data: { project: projectName, maxIter },
  });
}

// Invoked by `_botanist-plant <project>` (the botanist row of the workflow
// picker). Spawns the botanist immediately — no design prompt is collected
// here. The plant-time seed is the greeting form of buildBotanistSeed: the
// worker introduces itself and waits for the operator's brief as the first
// message in its pane (a better channel than tmux command-prompt: multi-line,
// no shell-metacharacter fragility). The designer model/effort default
// (Opus/xhigh) is applied in newWorker, and the composer's model/effort/base
// dims still layer on top.
export function plantBotanistFromPicker(projectName: string): void {
  const project = tryGetProject(projectName);
  if (!project) {
    tmuxDisplay(`Unknown project '${projectName}'.`);
    return;
  }

  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(seedsDir, `botanist-seed-${projectName}-${Date.now()}.txt`);
  fs.writeFileSync(seedFile, buildBotanistSeed());

  const draft = consumeSpawnDraft(projectName);
  const newName = newWorker({
    projectName,
    workflow: "botanist",
    seedMessageFile: seedFile,
    ...(draft.base ? { base: draft.base } : {}),
    // Model/effort dims layer over the workflow's Opus/xhigh default; crew and
    // build member are default-only and not consumed, so a foreign-harness
    // draft drops both dims rather than handing claude another harness's model.
    ...claudeOnlyLaunchOpts(project, draft),
  });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    tmuxDisplay(`Failed to plant botanist on '${projectName}'. Is the dashboard running?`);
    return;
  }
  log.info("workflow-picker", "planted botanist", {
    worker: newName, data: { project: projectName },
  });
}

// --- Workflow-picker shell command builders ---------------------------------

function shellCmdTrellisPicker(runner: string, project: string): string {
  return menuRunShell(`${runner} dashboard _trellis-picker ${shellEscape(project)}`);
}

function shellCmdGrowPlant(runner: string, project: string): string {
  // tmux command-prompt with %% substitution. The user's input replaces %%
  // verbatim — single quotes / shell metacharacters in the seed will break
  // the dispatch. Operators with complex seeds use the CLI plant path.
  const inner = `${runner} dashboard _grow-plant ${shellEscape(project)} %%`;
  return `command-prompt -p "Task description: " "run-shell ${shellEscape(inner)}"`;
}

