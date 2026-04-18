// Focus or unfocus plots: controls whether a plot appears in the ⌥p cycle.
import { loadConfig, saveConfig, getPlot, tryGetPlot, setPlotFocused, isPlotFocused, tryGetProject } from "../config.js";
import { dashboardExists } from "../session.js";
import { refreshDashboard } from "../dashboard/header.js";

export async function focus(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden focus <plot>");
  setFocus(name, true);
}

export async function unfocus(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden unfocus <plot>");
  setFocus(name, false);
}

function setFocus(name: string, focused: boolean): void {
  const config = loadConfig();
  if (!tryGetPlot(config, name)) {
    if (tryGetProject(name)) {
      throw new Error(
        `'${name}' is a project, not a plot. Use 'garden plot add <plot> ${name}' to add it to a plot.`,
      );
    }
    throw new Error(`Unknown plot: ${name}. Run 'garden plot' to see plots.`);
  }
  const plot = getPlot(config, name);
  if (isPlotFocused(plot) === focused) {
    console.log(`Plot '${name}' is already ${focused ? "focused" : "unfocused"}.`);
    return;
  }
  setPlotFocused(config, name, focused);
  saveConfig(config);
  console.log(`${focused ? "Focused" : "Unfocused"} plot '${name}'.`);
  if (dashboardExists()) refreshDashboard();
}
