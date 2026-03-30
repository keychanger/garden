// Reads and writes the global garden config (~/.garden/config.yml) and resolves project names.
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
  checks?: string;
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
  const tmpFile = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpFile, yaml.dump(config, { lineWidth: -1 }));
  fs.renameSync(tmpFile, CONFIG_PATH);
}

export function getProject(name: string): ProjectConfig & { name: string } {
  const config = loadConfig();
  const project = config.projects[name];
  if (!project) {
    throw new Error(
      `Unknown project: ${name}. Run 'garden list' to see projects.`
    );
  }
  return { ...project, name };
}

export function tryGetProject(name: string): (ProjectConfig & { name: string }) | null {
  try {
    const config = loadConfig();
    const project = config.projects[name];
    return project ? { ...project, name } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve project from args for session commands.
 * Tries first arg as a project name. If not a known project, falls back to
 * GARDEN_PROJECT env var or cwd detection, treating all args as non-name args.
 * Returns the resolved project and remaining args.
 */
export function resolveProjectFromArgs(args: string[]): {
  project: ProjectConfig & { name: string };
  remainingArgs: string[];
} {
  // Try first arg as a project name
  if (args[0] && tryGetProject(args[0])) {
    return {
      project: getProject(args[0]),
      remainingArgs: args.slice(1),
    };
  }
  // Fall back to env var or cwd detection
  return {
    project: resolveProject(),
    remainingArgs: args,
  };
}

/**
 * Resolve project name from (in priority order):
 * 1. Explicit argument
 * 2. GARDEN_PROJECT env var (set inside sessions)
 * 3. Current working directory (matches against registered project paths)
 */
export function resolveProject(nameArg?: string): ProjectConfig & { name: string } {
  const name = nameArg || process.env.GARDEN_PROJECT || detectProjectFromPath();
  if (!name) {
    throw new Error(
      "No project specified. Pass a project name, set GARDEN_PROJECT, or cd into a project directory."
    );
  }
  return getProject(name);
}

/**
 * Detect project name by matching a directory against registered project paths.
 * Defaults to cwd when no directory is provided.
 */
export function detectProjectFromPath(dir?: string): string | undefined {
  try {
    const config = loadConfig();
    const target = dir ?? process.cwd();
    for (const [name, project] of Object.entries(config.projects)) {
      if (target === project.path || target.startsWith(project.path + "/")) {
        return name;
      }
    }
  } catch {
    // Config not initialized yet
  }
  return undefined;
}
