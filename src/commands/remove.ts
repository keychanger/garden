// Removes a project from the garden config.
import { mutateConfig, purgeProjectFromPlots } from "../config.js";

export async function remove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: garden remove <name>");
  }

  mutateConfig(config => {
    if (!config.projects[name]) throw new Error(`Unknown project: ${name}`);
    delete config.projects[name];
    purgeProjectFromPlots(config, name);
  });
  console.log(`Removed project '${name}'`);
}
