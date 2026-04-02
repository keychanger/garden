// Reorder projects in the config to control hotkey assignment.
import { loadConfig, saveConfig, reorderProject } from "../config.js";

export async function reorder(args: string[]): Promise<void> {
  const name = args[0];
  const posArg = args[1];

  if (!name || !posArg) {
    throw new Error("Usage: garden reorder <project> <position>");
  }

  const position = parseInt(posArg, 10);
  if (isNaN(position)) {
    throw new Error(`Invalid position: ${posArg}`);
  }

  const config = loadConfig();
  reorderProject(config, name, position);
  saveConfig(config);

  const names = Object.keys(config.projects);
  console.log("Project order:");
  for (let i = 0; i < names.length; i++) {
    console.log(`  ${i + 1}. ${names[i]}`);
  }
}
