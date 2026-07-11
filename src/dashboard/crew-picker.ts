// The ⌥⇧C crew picker: a tmux display-menu of the crews available for the
// focused project (generated from harnesses + configured providers), applying
// the chosen one to project config. A crew is project-level — it sets the
// worker default + the review roles — so this reconfigures the project's fleet
// rather than spawning a worker. Distinct from the ⌥⇧N workflow picker.
import { execFileSync } from "node:child_process";
import { loadConfig, tryGetProject } from "../config.js";
import { readDashState } from "./state.js";
import { resolveGardenRunner } from "./runner.js";
import { shellEscape, tmuxDisplay, menuRunShell } from "./tmux.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import { listCrews, deriveCrew, getCrew, applyCrew, type CrewSpec } from "./crew.js";

export interface CrewMenuItem {
  label: string;
  key: string;
  command: string;
}
export interface CrewPickerPlan {
  title: string;
  items: CrewMenuItem[];
}

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
  const items: CrewMenuItem[] = crews.map((crew, i) => ({
    label: crew.name === current ? `${crew.name}  ✓` : crew.name,
    key: i < 9 ? String(i + 1) : "",
    command: menuRunShell(`${runner} dashboard _crew-set ${shellEscape(projectName)} ${shellEscape(crew.name)}`),
  }));
  return { title: `Crew: ${projectName}${current ? ` (${current})` : ""}`, items };
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

  const menuArgs: string[] = ["display-menu", "-O", "-T", plan.title, "-x", "C", "-y", "C"];
  for (const item of plan.items) menuArgs.push(item.label, item.key, item.command);
  try {
    execFileSync("tmux", menuArgs, { stdio: "ignore" });
  } catch (err) {
    log.warn("crew-picker", "display-menu failed", {
      data: { error: String(err), project: projectName },
    });
  }
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
