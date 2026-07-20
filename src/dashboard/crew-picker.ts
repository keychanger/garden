// The ⌥⇧C crew picker: a tmux display-menu of the crews available for the
// focused project (generated from harnesses + configured providers), applying
// the chosen one to project config. A crew is project-level — it sets the
// worker default + the review roles — so this reconfigures the project's fleet
// rather than spawning a worker. Distinct from the ⌥⇧N workflow picker.
import { loadConfig, tryGetProject } from "../config.js";
import { readDashState } from "./state.js";
import { resolveGardenRunner } from "./runner.js";
import { shellEscape, tmuxDisplay, menuRunShell } from "./tmux.js";
import { runMenu } from "./menu.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import {
  listCrews, deriveCrew, getCrew, applyCrew, formatRecipe,
  listMembers, reviewerMembers, saveCrew, deleteCrew, builtinCrews, type CrewSpec,
} from "./crew.js";
import { readCrewDraft, writeCrewDraft, clearCrewDraft, seedCrewDraft, type CrewDraft } from "./crew-draft.js";

export interface CrewMenuItem {
  label: string;
  key: string;
  command: string;
  /** Horizontal rule instead of a selectable item (label/key/command unused). */
  sep?: boolean;
}
export interface CrewPickerPlan {
  title: string;
  items: CrewMenuItem[];
}

// Curated dimension choices for the composer submenus. Same lists the ⌥,
// project menu offers for its model/effort rows — the CLI (`garden crew
// add --model <id>`) remains the escape hatch for exotic model ids.
const CREW_MODEL_CHOICES = ["opus", "sonnet", "haiku", "fable"];
const CREW_EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "ultra"];

// Pure: build the display-menu plan for a project's crews. No tmux/fs/registry
// I/O, so tests drive it directly. Each item's command MUST be run-shell
// wrapped: tmux parses a menu item's command as a tmux command, so a bare
// `<node> <cli.js> dashboard _crew-set …` fails with "unknown command: <node>"
// and the crew silently does not change.
export function buildCrewPickerPlan(
  projectName: string,
  current: string | null,
  crews: CrewSpec[],
  runner: string,
): CrewPickerPlan {
  // A stored crew's recipe is the whole point of naming it — `heavy` says
  // nothing without `claude opus/xhigh → claude opus` beside it. Builtins are
  // self-describing (the name IS the pairing), so they stay bare.
  const width = Math.max(...crews.map((c) => c.name.length), 0);
  const items: CrewMenuItem[] = crews.map((crew, i) => {
    const recipe = crew.builtin ? "" : `  ${formatRecipe(crew)}`;
    const name = recipe ? crew.name.padEnd(width) : crew.name;
    return {
      label: `${name}${recipe}${crew.name === current ? "  ✓" : ""}`,
      key: i < 9 ? String(i + 1) : "",
      command: menuRunShell(`${runner} dashboard _crew-set ${shellEscape(projectName)} ${shellEscape(crew.name)}`),
    };
  });
  // Management rows below the pick list: selecting a crew BINDS it (the common
  // act), while these three define what there is to bind.
  //
  // All three are shown UNCONDITIONALLY, including when no stored crew exists
  // yet. Gating edit/delete on `crews.some(c => !c.builtin)` reads as a
  // half-shipped feature — the operator opens the menu to manage crews, sees a
  // lone "new crew…", and cannot tell an empty state from a missing one. tmux
  // display-menu has no disabled-row rendering to lean on (see the "-"-prefix
  // note in menu.ts), so the choice is show-with-a-message or hide entirely;
  // the message is far cheaper than the confusion. runStoredCrewPicker answers
  // an empty list with "No crews defined yet — use 'new crew…' first."
  items.push({ label: "", key: "", command: "", sep: true });
  items.push({
    label: "new crew…",
    key: "n",
    command: menuRunShell(`${runner} dashboard _crew-compose ${shellEscape(projectName)} new`),
  });
  items.push({
    label: "edit crew…",
    key: "e",
    command: menuRunShell(`${runner} dashboard _crew-pick-stored ${shellEscape(projectName)} edit`),
  });
  items.push({
    label: "delete crew…",
    key: "d",
    command: menuRunShell(`${runner} dashboard _crew-pick-stored ${shellEscape(projectName)} delete`),
  });
  return { title: `Crew: ${projectName}${current ? ` (${current})` : ""}`, items };
}

// The composer: one row per dimension, plus save/cancel. The title reads back
// the recipe as composed so far, so the operator sees what they are building
// without leaving the menu.
export function buildCrewComposerPlan(
  projectName: string,
  draft: CrewDraft,
  runner: string,
): CrewPickerPlan {
  // Quick-keys are explicit, not derived from the field name: `reviewer` and
  // `review-model` both start with `r`, and tmux binds only the first of a
  // duplicate pair — the second row would be unreachable by key.
  const d = (field: string, key: string, value: string | undefined, fallback: string): CrewMenuItem => ({
    label: `${field}: ${value ?? fallback}`,
    key,
    command: menuRunShell(`${runner} dashboard _crew-dim ${shellEscape(projectName)} ${shellEscape(field)}`),
  });
  const items: CrewMenuItem[] = [
    d("worker", "w", draft.worker, "(required)"),
    d("model", "m", draft.workerModel, "(inherit)"),
    d("effort", "e", draft.workerEffort, "(inherit)"),
    d("reviewer", "r", draft.review, "(required)"),
    d("review-model", "v", draft.reviewModel, "(safe default)"),
    { label: "", key: "", command: "", sep: true },
  ];
  // Save is offered only once both halves are named — a crew without them
  // cannot resolve, and failing at the name prompt would waste the typing.
  if (draft.worker && draft.review) {
    items.push(draft.editing
      ? {
        label: `save '${draft.editing}'`,
        key: "s",
        command: menuRunShell(`${runner} dashboard _crew-save ${shellEscape(projectName)} ${shellEscape(draft.editing)}`),
      }
      : {
        label: "save as…",
        key: "s",
        command: crewNamePrompt(runner, projectName),
      });
  }
  items.push({
    label: "cancel",
    key: "q",
    command: menuRunShell(`${runner} dashboard _crew-cancel ${shellEscape(projectName)}`),
  });

  const recipe = `${draft.worker ?? "?"}${dims(draft.workerModel, draft.workerEffort)}`
    + ` → ${draft.review ?? "?"}${dims(draft.reviewModel, undefined)}`;
  const verb = draft.editing ? `Edit crew '${draft.editing}'` : "New crew";
  return { title: `${verb} (${recipe})`, items };
}

function dims(model?: string, effort?: string): string {
  const joined = [model, effort].filter(Boolean).join("/");
  return joined ? ` ${joined}` : "";
}

// tmux command-prompt for the new crew's name. Already a tmux command, so it is
// NOT run-shell wrapped (the inner dispatch is). The name replaces %% verbatim;
// a name with shell metacharacters breaks the dispatch, which is why the CLI
// (`garden crew add`) stays the path for anything exotic.
function crewNamePrompt(runner: string, projectName: string): string {
  const inner = `${runner} dashboard _crew-save ${shellEscape(projectName)} %%`;
  return `command-prompt -p "Crew name: " "run-shell ${shellEscape(inner)}"`;
}

// A dimension submenu: the curated choices for one field, plus a clear row for
// the optional ones. Selecting writes the draft and re-opens the composer.
export function buildCrewDimSubmenuPlan(
  projectName: string,
  field: string,
  choices: string[],
  current: string | undefined,
  clearLabel: string | null,
  runner: string,
): CrewPickerPlan {
  const items: CrewMenuItem[] = choices.map((choice, i) => ({
    label: `${choice}${choice === current ? "  ✓" : ""}`,
    key: i < 9 ? String(i + 1) : "",
    command: menuRunShell(
      `${runner} dashboard _crew-dim-set ${shellEscape(projectName)} ${shellEscape(field)} ${shellEscape(choice)}`,
    ),
  }));
  if (clearLabel) {
    items.push({ label: "", key: "", command: "", sep: true });
    items.push({
      label: clearLabel,
      key: "0",
      command: menuRunShell(`${runner} dashboard _crew-dim-set ${shellEscape(projectName)} ${shellEscape(field)} ''`),
    });
  }
  return { title: `${field} for the new crew`, items };
}

// The crew chooser for the edit / delete flows. Edit lists every crew (see
// below); delete lists stored crews only.
export function buildStoredCrewPickerPlan(
  projectName: string,
  action: "edit" | "delete",
  crews: CrewSpec[],
  runner: string,
  // Every name the generated set produces. Needed because `crews` (from
  // listCrews) has already dropped any builtin a stored crew shadows, so the
  // shadowing relationship is not recoverable from that list alone.
  builtinNames: readonly string[] = [],
): CrewPickerPlan {
  // EDIT lists every crew, builtins included. A builtin has no storage to edit
  // in place, but a stored crew SHADOWS a builtin of the same name — so editing
  // one materializes it as an override you then tune, and deleting that
  // override reverts to the generated pairing. That round trip is why builtins
  // belong here: `all-codex` is the natural starting point for "codex, but
  // pinned to opus", and requiring `crew add … --from` first was busywork.
  //
  // DELETE lists stored crews only: a pure builtin is generated, so there is
  // nothing to remove and selecting it could only produce an error.
  const listed = action === "edit" ? crews : crews.filter((c) => !c.builtin);
  const width = Math.max(...listed.map((c) => c.name.length), 0);
  const recipeWidth = Math.max(...listed.map((c) => formatRecipe(c).length), 0);
  const items: CrewMenuItem[] = listed.map((crew, i) => {
    // Tag what selecting the row will DO, since the two cases differ in kind:
    // editing a builtin creates an override; deleting an override restores one.
    const tag = crew.builtin
      ? "  builtin — edit to override"
      : (builtinNames.includes(crew.name) ? "  reverts to builtin" : "");
    return {
      label: `${crew.name.padEnd(width)}  ${formatRecipe(crew).padEnd(tag ? recipeWidth : 0)}${tag}`,
      key: i < 9 ? String(i + 1) : "",
      command: menuRunShell(
        `${runner} dashboard _crew-${action} ${shellEscape(projectName)} ${shellEscape(crew.name)}`,
      ),
    };
  });
  return { title: action === "edit" ? "Edit which crew?" : "Delete which crew?", items };
}

// Spawned by the ⌥⇧C hotkey. Resolves the focused project, builds the plan,
// and drives tmux display-menu.
export function runCrewPicker(explicitProject?: string): void {
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

  const config = loadConfig();
  const plan = buildCrewPickerPlan(
    projectName,
    deriveCrew(project, config),
    listCrews(config),
    resolveGardenRunner(),
  );

  runnerAndMenu(plan);
}

// _crew-set <project> <crew>: apply the chosen crew and re-bake the status pane
// so its badge updates immediately.
export function applyCrewFromPicker(projectName: string, crewName: string): void {
  const config = loadConfig();
  const spec = getCrew(crewName, config);
  if (!spec) {
    tmuxDisplay(`Unknown crew '${crewName}'.`);
    return;
  }
  applyCrew(projectName, spec);
  log.info("crew-picker", "applied crew", { data: { project: projectName, crew: crewName } });
  tmuxDisplay(`Crew set: ${projectName} → ${crewName}`);
  try {
    refreshDashboard();
  } catch {
    /* best effort — the next status bake picks it up */
  }
}

// --- composer runners -------------------------------------------------------

function runnerAndMenu(plan: CrewPickerPlan): void {
  runMenu({
    title: plan.title,
    rows: plan.items.map((i) => (i.sep ? { label: "", sep: true } : { label: i.label, key: i.key, tmux: i.command })),
  });
}

// _crew-compose <project> new: start a fresh composer.
export function runCrewComposer(projectName: string, mode?: string): void {
  if (mode === "new") clearCrewDraft();
  runnerAndMenu(buildCrewComposerPlan(projectName, readCrewDraft(), resolveGardenRunner()));
}

// _crew-pick-stored <project> <edit|delete>: choose which stored crew to act on.
export function runStoredCrewPicker(projectName: string, action: string): void {
  if (action !== "edit" && action !== "delete") {
    tmuxDisplay(`Unknown crew action '${action}'.`);
    return;
  }
  const config = loadConfig();
  const crews = listCrews(config);
  // Only DELETE can come up empty — edit always has the builtins to offer.
  if (action === "delete" && !crews.some((c) => !c.builtin)) {
    tmuxDisplay("No crews defined yet — use 'new crew…' first.");
    return;
  }
  runnerAndMenu(buildStoredCrewPickerPlan(
    projectName, action, crews, resolveGardenRunner(), builtinCrews(config).map((c) => c.name),
  ));
}

// _crew-edit <project> <name>: seed the draft from an existing crew and open
// the composer on it. A BUILTIN is editable here: it has no storage of its own,
// so saving materializes a stored crew of the same name that shadows it
// (listCrews resolves stored-over-builtin). Deleting that override later
// restores the generated pairing, so the round trip is lossless.
export function runCrewEdit(projectName: string, crewName: string): void {
  const spec = getCrew(crewName, loadConfig());
  if (!spec) {
    tmuxDisplay(`Unknown crew '${crewName}'.`);
    return;
  }
  seedCrewDraft(crewName, {
    worker: spec.worker.name,
    ...(spec.worker.model ? { workerModel: spec.worker.model } : {}),
    ...(spec.worker.effort ? { workerEffort: spec.worker.effort } : {}),
    review: spec.review.name,
    ...(spec.review.model ? { reviewModel: spec.review.model } : {}),
  });
  runCrewComposer(projectName);
}

// _crew-dim <project> <field>: open the submenu for one composer dimension.
export function runCrewDimSubmenu(projectName: string, field: string): void {
  const config = loadConfig();
  const draft = readCrewDraft();
  const runner = resolveGardenRunner();
  const plan = (() => {
    switch (field) {
      case "worker":
        return buildCrewDimSubmenuPlan(projectName, field, listMembers(config).map((m) => m.name), draft.worker, null, runner);
      case "reviewer":
        // Only harness members may review — the safety-net asymmetry, enforced
        // here so the menu cannot even offer an invalid pairing.
        return buildCrewDimSubmenuPlan(projectName, field, reviewerMembers(config).map((m) => m.name), draft.review, null, runner);
      case "model":
        return buildCrewDimSubmenuPlan(projectName, field, CREW_MODEL_CHOICES, draft.workerModel, "inherit — no model pinned", runner);
      case "effort":
        return buildCrewDimSubmenuPlan(projectName, field, CREW_EFFORT_CHOICES, draft.workerEffort, "inherit — no effort pinned", runner);
      case "review-model":
        return buildCrewDimSubmenuPlan(projectName, field, CREW_MODEL_CHOICES, draft.reviewModel, "safe default — Opus on claude-code", runner);
      default:
        return null;
    }
  })();
  if (!plan) {
    tmuxDisplay(`Unknown crew dimension '${field}'.`);
    return;
  }
  runnerAndMenu(plan);
}

// _crew-dim-set <project> <field> <value>: stage one dimension, re-open the
// composer so composition continues where it left off.
export function setCrewDimFromPicker(projectName: string, field: string, value: string): void {
  const patch: CrewDraft = {};
  switch (field) {
    case "worker": patch.worker = value; break;
    case "reviewer": patch.review = value; break;
    case "model": patch.workerModel = value; break;
    case "effort": patch.workerEffort = value; break;
    case "review-model": patch.reviewModel = value; break;
    default:
      tmuxDisplay(`Unknown crew dimension '${field}'.`);
      return;
  }
  writeCrewDraft(patch);
  runCrewComposer(projectName);
}

// _crew-save <project> <name>: validate + persist the composed crew. Reuses
// saveCrew, so the menu path gets the same member/asymmetry validation the CLI
// does rather than a second copy that could drift.
export function saveCrewFromPicker(projectName: string, crewName: string): void {
  const name = crewName.trim();
  if (!name) {
    tmuxDisplay("Crew name required.");
    return;
  }
  const draft = readCrewDraft();
  if (!draft.worker || !draft.review) {
    tmuxDisplay("Pick a worker and a reviewer first.");
    return;
  }
  const config = loadConfig();
  // A new crew must not silently replace an existing one; editing targets the
  // name it was seeded with, so a collision there is the expected overwrite.
  if (!draft.editing && config.crews?.[name]) {
    tmuxDisplay(`Crew '${name}' already exists — edit it instead.`);
    return;
  }
  try {
    saveCrew(name, {
      worker: {
        member: draft.worker,
        ...(draft.workerModel ? { model: draft.workerModel } : {}),
        ...(draft.workerEffort ? { effort: draft.workerEffort } : {}),
      },
      review: { member: draft.review, ...(draft.reviewModel ? { model: draft.reviewModel } : {}) },
    });
  } catch (err) {
    tmuxDisplay(String(err instanceof Error ? err.message : err));
    return;
  }
  clearCrewDraft();
  log.info("crew-picker", draft.editing ? "edited crew" : "created crew", { data: { crew: name } });
  const spec = getCrew(name, loadConfig());
  tmuxDisplay(`Crew ${draft.editing ? "updated" : "created"}: ${name}${spec ? ` (${formatRecipe(spec)})` : ""}`);
  // Back to the picker so the new crew can be bound immediately — creating one
  // is nearly always a prelude to using it.
  runCrewPicker(projectName);
}

// _crew-delete <project> <name>: remove a stored crew, reporting any projects
// left holding an (inert) dangling reference.
export function deleteCrewFromPicker(projectName: string, crewName: string): void {
  // Whether this name also exists in the generated set decides what deleting
  // MEANS: removing an override (the builtin comes back, and any bound project
  // keeps resolving) versus removing the name outright (bound projects fall
  // back to their own keys). Checked before the delete, while both still exist.
  const revertsToBuiltin = builtinCrews(loadConfig()).some((c) => c.name === crewName);
  let bound: string[];
  try {
    bound = deleteCrew(crewName);
  } catch (err) {
    tmuxDisplay(String(err instanceof Error ? err.message : err));
    return;
  }
  log.info("crew-picker", "deleted crew", { data: { crew: crewName, bound, revertsToBuiltin } });
  tmuxDisplay(
    revertsToBuiltin
      ? `Override removed: ${crewName} is the builtin again`
      : `Crew deleted: ${crewName}`
        + (bound.length > 0 ? ` — ${bound.join(", ")} now resolve from their own keys` : ""),
  );
  try { refreshDashboard(); } catch { /* best effort */ }
  runCrewPicker(projectName);
}

// _crew-cancel <project>: discard the draft and return to the picker.
export function cancelCrewComposer(projectName: string): void {
  clearCrewDraft();
  runCrewPicker(projectName);
}
