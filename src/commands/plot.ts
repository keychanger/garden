// Manage plots: named, ordered subsets of projects that drive the dashboard view.
import {
  loadConfig,
  saveConfig,
  plotsMap,
  plotNames,
  getPlot,
  tryGetPlot,
  createPlot as createPlotCfg,
  deletePlot as deletePlotCfg,
  renamePlot as renamePlotCfg,
  addProjectToPlot,
  removeProjectFromPlot,
  reorderProjectInPlot,
  isPlotFocused,
  PLOT_MAX_PROJECTS,
  type GardenConfig,
  type PlotConfig,
} from "../config.js";
import { output } from "../output.js";
import { readDashState, writeDashState, withStateLock } from "../dashboard/state.js";
import { dashboardExists } from "../session.js";
import { refreshDashboard } from "../dashboard/header.js";

export async function plot(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === "list") return listPlots();
  if (sub === "create") return cmdCreate(rest);
  if (sub === "delete") return cmdDelete(rest);
  if (sub === "rename") return cmdRename(rest);
  if (sub === "add") return cmdAdd(rest);
  if (sub === "remove") return cmdRemove(rest);
  if (sub === "reorder") return cmdReorder(rest);
  if (sub === "show") return cmdShow(rest);

  // Bare name → activate
  const config = loadConfig();
  if (tryGetPlot(config, sub)) return activatePlot(sub);

  throw new Error(
    `Unknown plot subcommand or plot: ${sub}. Try 'garden plot' to list plots.`,
  );
}

interface PlotListEntry {
  name: string;
  projects: string[];
  focused: boolean;
  active: boolean;
}

function listPlots(): void {
  const config = loadConfig();
  const plots = plotsMap(config);
  const names = Object.keys(plots);
  const activePlot = currentActivePlot(config);

  if (names.length === 0) {
    console.log("No plots. Create one with 'garden plot create <name> [project...]'.");
    return;
  }

  const entries: PlotListEntry[] = names.map((name) => ({
    name,
    projects: plots[name].projects,
    focused: isPlotFocused(plots[name]),
    active: name === activePlot,
  }));

  output(entries, (data) => {
    const items = data as PlotListEntry[];
    const nameWidth = Math.max(8, ...items.map(i => i.name.length));
    return items
      .map((p) => {
        const marker = p.active ? " *" : "  ";
        const name = p.active ? `\x1b[1;32m${p.name.padEnd(nameWidth)}\x1b[0m` : p.name.padEnd(nameWidth);
        const projectList = p.projects.length > 0 ? p.projects.join(", ") : "(empty)";
        const focusedTag = p.focused ? "" : "  \x1b[2m(unfocused)\x1b[0m";
        return `${marker}${name}  ${projectList}${focusedTag}`;
      })
      .join("\n");
  });
}

function cmdCreate(args: string[]): void {
  const name = args[0];
  const projects = args.slice(1);
  if (!name) throw new Error("Usage: garden plot create <name> [project...]");

  const config = loadConfig();
  createPlotCfg(config, name, projects);
  saveConfig(config);

  // Auto-activate only when no plot is active — so first-time users land on
  // their new plot, but existing workflows don't silently jump views.
  const current = currentActivePlot(config);
  const autoActivated = !current;
  if (autoActivated) setActivePlot(name);

  console.log(
    `Created plot '${name}' with ${projects.length} project${projects.length === 1 ? "" : "s"}${autoActivated ? " (activated)" : ""}.`,
  );
  if (dashboardExists()) refreshDashboard();
}

function cmdDelete(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error("Usage: garden plot delete <name>");

  const config = loadConfig();
  if (!tryGetPlot(config, name)) throw new Error(`Unknown plot: ${name}.`);

  const active = currentActivePlot(config);
  if (active === name) {
    throw new Error(
      `Cannot delete the active plot '${name}'. Switch first: 'garden plot <other>'.`,
    );
  }

  deletePlotCfg(config, name);
  saveConfig(config);
  console.log(`Deleted plot '${name}'.`);
  if (dashboardExists()) refreshDashboard();
}

function cmdRename(args: string[]): void {
  const [oldName, newName] = args;
  if (!oldName || !newName) throw new Error("Usage: garden plot rename <old> <new>");

  const config = loadConfig();
  renamePlotCfg(config, oldName, newName);

  // Migrate the active plot pointer if it referenced the renamed plot.
  const active = currentActivePlot(config);
  saveConfig(config);
  if (active === oldName) setActivePlot(newName);

  console.log(`Renamed plot '${oldName}' → '${newName}'.`);
  if (dashboardExists()) refreshDashboard();
}

function cmdAdd(args: string[]): void {
  const [plotName, projectName, atKeyword, posArg] = args;
  if (!plotName || !projectName) {
    throw new Error("Usage: garden plot add <plot> <project> [at <position>]");
  }

  let position: number | undefined;
  if (atKeyword) {
    if (atKeyword !== "at" || !posArg) {
      throw new Error("Usage: garden plot add <plot> <project> [at <position>]");
    }
    position = parseInt(posArg, 10);
    if (!Number.isFinite(position)) {
      throw new Error(`Invalid position: ${posArg}`);
    }
  }

  const config = loadConfig();
  addProjectToPlot(config, plotName, projectName, position);
  saveConfig(config);
  console.log(`Added '${projectName}' to plot '${plotName}'.`);
  if (dashboardExists()) refreshDashboard();
}

function cmdRemove(args: string[]): void {
  const [plotName, projectName] = args;
  if (!plotName || !projectName) {
    throw new Error("Usage: garden plot remove <plot> <project>");
  }

  const config = loadConfig();
  removeProjectFromPlot(config, plotName, projectName);
  saveConfig(config);
  console.log(`Removed '${projectName}' from plot '${plotName}'.`);
  if (dashboardExists()) refreshDashboard();
}

function cmdReorder(args: string[]): void {
  const [plotName, projectName, posArg] = args;
  if (!plotName || !projectName || !posArg) {
    throw new Error("Usage: garden plot reorder <plot> <project> <position>");
  }
  const position = parseInt(posArg, 10);
  if (!Number.isFinite(position)) throw new Error(`Invalid position: ${posArg}`);

  const config = loadConfig();
  reorderProjectInPlot(config, plotName, projectName, position);
  saveConfig(config);
  console.log(`Moved '${projectName}' to position ${position} in plot '${plotName}'.`);
  if (dashboardExists()) refreshDashboard();
}

function cmdShow(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error("Usage: garden plot show <name>");
  const config = loadConfig();
  const plot = getPlot(config, name);
  printPlot(name, plot);
}

function printPlot(name: string, plot: PlotConfig): void {
  output(
    { name, projects: plot.projects, focused: isPlotFocused(plot) },
    () => {
      const header = `${name}${isPlotFocused(plot) ? "" : " (unfocused)"} — ${plot.projects.length}/${PLOT_MAX_PROJECTS}`;
      const rows = plot.projects.length === 0
        ? ["  (empty)"]
        : plot.projects.map((p, i) => `  ${i + 1}. ${p}`);
      return [header, ...rows].join("\n");
    },
  );
}

function activatePlot(name: string): void {
  setActivePlot(name);
  console.log(`Active plot: ${name}`);
  if (dashboardExists()) refreshDashboard();
}

function setActivePlot(name: string | null): void {
  withStateLock(() => {
    const state = readDashState();
    state.activePlot = name;
    writeDashState(state);
  });
}

function currentActivePlot(config: GardenConfig): string | null {
  const state = readDashState();
  if (!state.activePlot) return null;
  return plotNames(config).includes(state.activePlot) ? state.activePlot : null;
}
