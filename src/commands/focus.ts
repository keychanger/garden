// Focus or unfocus plots: controls whether a plot appears in the ⌥p cycle.
import { mutateConfig, getPlot, tryGetPlot, setPlotFocused, isPlotFocused } from "../config.js";
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
  const changed = mutateConfig(config => {
    if (!tryGetPlot(config, name)) {
      if (config.projects[name]) {
        throw new Error(
          `'${name}' is a project, not a plot. Use 'garden plot add <plot> ${name}' to add it to a plot.`,
        );
      }
      throw new Error(`Unknown plot: ${name}. Run 'garden plot' to see plots.`);
    }
    const plot = getPlot(config, name);
    if (isPlotFocused(plot) === focused) return false;
    setPlotFocused(config, name, focused);
    return true;
  });
  if (!changed) {
    console.log(`Plot '${name}' is already ${focused ? "focused" : "unfocused"}.`);
    return;
  }
  console.log(`${focused ? "Focused" : "Unfocused"} plot '${name}'.`);
  if (dashboardExists()) refreshDashboard();
}
