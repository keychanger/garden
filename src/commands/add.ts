// Adds a project directory to the garden config. Name is derived from the directory basename.
import path from "node:path";
import fs from "node:fs";
import { loadConfig, saveConfig } from "../config.js";
import { dashboardExists } from "../session.js";
import { refreshDashboard } from "../dashboard/header.js";

// tmux uses : and . as session:window.pane delimiters; these substrings
// collide with the underscore-prefixed window naming convention in window-names.ts.
const RESERVED_SUBSTRINGS = ["-worker-", "-shell", "-active", "-poller", "-review-"];

function validateProjectName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(
      `Invalid project name '${name}': must start with alphanumeric and contain only letters, digits, hyphens, and underscores. ` +
      `Rename the directory or use a symlink.`,
    );
  }
  for (const sub of RESERVED_SUBSTRINGS) {
    if (name.includes(sub)) {
      throw new Error(
        `Invalid project name '${name}': must not contain '${sub}' (reserved for tmux window naming). ` +
        `Rename the directory or use a symlink.`,
      );
    }
  }
}

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
  validateProjectName(name);
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
