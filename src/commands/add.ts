// Adds a project directory to the garden config. Name is derived from the directory basename.
import path from "node:path";
import fs from "node:fs";
import { loadConfig, saveConfig } from "../config.js";
import { dashboardExists } from "../session.js";
import { refreshDashboard } from "../dashboard/header.js";

export async function add(args: string[]): Promise<void> {
  const rawPath = args[0] ?? ".";
  const resolved = path.resolve(rawPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  const name = path.basename(resolved);
  const config = loadConfig();

  if (config.projects[name]) {
    const existing = config.projects[name].path;
    if (existing === resolved) {
      console.log(`Project '${name}' is already added.`);
      return;
    }
    throw new Error(
      `A project named '${name}' already exists at ${existing}. Remove it first.`
    );
  }

  config.projects[name] = { path: resolved };
  saveConfig(config);
  console.log(`Added project '${name}' (${resolved})`);

  if (dashboardExists()) {
    refreshDashboard();
  }
}
