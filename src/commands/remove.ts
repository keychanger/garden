// Unregisters a project from the garden config.
import { loadConfig, saveConfig } from "../config.js";

export async function unregister(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: garden unregister <name>");
  }

  const config = loadConfig();
  if (!config.projects[name]) {
    throw new Error(`Unknown project: ${name}`);
  }

  delete config.projects[name];
  saveConfig(config);
  console.log(`Unregistered project '${name}'`);
}
