// Focus or unfocus projects to control dashboard visibility.
import { loadConfig, saveConfig, getProject } from "../config.js";
import { refreshDashboard } from "../dashboard/header.js";

export async function focus(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden focus <project>");

  const project = getProject(name);
  if (project.focused !== false) {
    console.log(`Project '${name}' is already focused.`);
    return;
  }

  const config = loadConfig();
  delete config.projects[name].focused;
  saveConfig(config);
  refreshDashboard();
  console.log(`Focused '${name}'`);
}

export async function unfocus(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden unfocus <project>");

  const project = getProject(name);
  if (project.focused === false) {
    console.log(`Project '${name}' is already unfocused.`);
    return;
  }

  const config = loadConfig();
  config.projects[name].focused = false;
  saveConfig(config);
  refreshDashboard();
  console.log(`Unfocused '${name}'`);
}
