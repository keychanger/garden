// Order focused projects in the config to control hotkey assignment.
import { loadConfig, saveConfig, orderProject, getFocusedProjectNames } from "../config.js";
import { refreshDashboard } from "../dashboard/header.js";

export async function order(args: string[]): Promise<void> {
  const name = args[0];
  const posArg = args[1];

  if (!name || !posArg) {
    throw new Error("Usage: garden order <project> <position>");
  }

  const position = parseInt(posArg, 10);
  if (isNaN(position)) {
    throw new Error(`Invalid position: ${posArg}`);
  }

  const config = loadConfig();
  orderProject(config, name, position);
  saveConfig(config);
  refreshDashboard();

  const focused = getFocusedProjectNames(config);
  console.log("Project order:");
  for (let i = 0; i < focused.length; i++) {
    console.log(`  ${i + 1}. ${focused[i]}`);
  }
}
