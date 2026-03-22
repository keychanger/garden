import { loadConfig, saveConfig } from "../config.js";

export async function remove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: garden remove <name>");
  }

  const config = loadConfig();
  if (!config.projects[name]) {
    throw new Error(`Unknown project: ${name}`);
  }

  delete config.projects[name];
  saveConfig(config);
  console.log(`Removed project '${name}'`);
}
