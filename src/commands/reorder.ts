// Reorder plots in the ⌥p cycle: moves a plot within the ordered plots map.
import { loadConfig, saveConfig, reorderPlotInCycle, tryGetPlot, tryGetProject, plotNames } from "../config.js";
import { dashboardExists } from "../session.js";
import { refreshDashboard } from "../dashboard/header.js";

export async function reorder(args: string[]): Promise<void> {
  const name = args[0];
  const posArg = args[1];

  if (!name || !posArg) {
    throw new Error("Usage: garden reorder <plot> <position>");
  }

  const position = parseInt(posArg, 10);
  if (!Number.isFinite(position)) {
    throw new Error(`Invalid position: ${posArg}`);
  }

  const config = loadConfig();
  if (!tryGetPlot(config, name)) {
    if (tryGetProject(name)) {
      throw new Error(
        `'${name}' is a project, not a plot. Use 'garden plot reorder <plot> ${name} <position>' to move a project inside a plot.`,
      );
    }
    throw new Error(`Unknown plot: ${name}. Run 'garden plot' to see plots.`);
  }

  reorderPlotInCycle(config, name, position);
  saveConfig(config);
  if (dashboardExists()) refreshDashboard();

  console.log("Plot order:");
  const names = plotNames(config);
  for (let i = 0; i < names.length; i++) {
    console.log(`  ${i + 1}. ${names[i]}`);
  }
}
