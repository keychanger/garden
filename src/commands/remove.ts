// Removes a project from the garden config.
import { mutateConfig, purgeProjectFromPlots } from "../config.js";
import { readRegistry, isTaintedRegistry } from "../dashboard/registry.js";

export async function remove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: garden remove <name>");
  }

  // A project's workers outlive its config entry: the status pane and the
  // pollers resolve projects through the config, so they would keep running
  // with no row, no review and no merge. Removing workers is the operator's
  // act, so this refuses and names them, as `provider remove` refuses while a
  // provider is in use. An unreadable registry cannot show there are none.
  const registry = readRegistry();
  if (isTaintedRegistry(registry)) {
    throw new Error(
      `The worker registry could not be read, so it is unknown whether '${name}' has workers. `
      + `Nothing was removed.`,
    );
  }
  const workers = Object.hasOwn(registry.workers, name) ? registry.workers[name] : [];
  if (workers.length > 0) {
    throw new Error(
      `Project '${name}' still has registered workers: ${workers.map(w => `${name}/${w.name}`).join(", ")}. `
      + `Run 'garden workers stop <worker>' for each, then remove the project. Nothing was removed.`,
    );
  }

  mutateConfig(config => {
    if (!config.projects[name]) throw new Error(`Unknown project: ${name}`);
    delete config.projects[name];
    purgeProjectFromPlots(config, name);
  });
  console.log(`Removed project '${name}'`);
}
