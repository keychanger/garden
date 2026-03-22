import path from "node:path";
import fs from "node:fs";
import { loadConfig, saveConfig } from "../config.js";

export async function add(args: string[]): Promise<void> {
  const name = args[0];
  const rawPath = args[1];

  if (!name || !rawPath) {
    throw new Error("Usage: garden add <name> <path>");
  }

  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  const config = loadConfig();
  if (config.projects[name]) {
    throw new Error(`Project '${name}' already exists.`);
  }

  config.projects[name] = { path: resolved };
  saveConfig(config);
  console.log(`Added project '${name}' at ${resolved}`);
}
