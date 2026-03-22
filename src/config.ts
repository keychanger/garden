import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export const GARDEN_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".garden"
);
export const CONFIG_PATH = path.join(GARDEN_DIR, "config.yml");
export const SESSIONS_DIR = path.join(GARDEN_DIR, "sessions");

export interface ProjectConfig {
  path: string;
}

export interface GardenConfig {
  projects: Record<string, ProjectConfig>;
}

export function loadConfig(): GardenConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      "Garden is not initialized. Run 'garden init' first."
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = yaml.load(raw) as GardenConfig | null;
  return parsed ?? { projects: {} };
}

export function saveConfig(config: GardenConfig): void {
  fs.mkdirSync(GARDEN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: -1 }));
}

export function getProject(name: string): ProjectConfig & { name: string } {
  const config = loadConfig();
  const project = config.projects[name];
  if (!project) {
    throw new Error(
      `Unknown project: ${name}. Run 'garden list' to see registered projects.`
    );
  }
  return { ...project, name };
}

/**
 * Resolve project name from argument or GARDEN_PROJECT env var.
 * Used by commands that can run inside a session (tasks, context).
 */
export function resolveProject(nameArg?: string): ProjectConfig & { name: string } {
  const name = nameArg || process.env.GARDEN_PROJECT;
  if (!name) {
    throw new Error(
      "No project specified. Pass a project name or set GARDEN_PROJECT."
    );
  }
  return getProject(name);
}
