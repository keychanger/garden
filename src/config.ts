// Reads and writes the global garden config (~/.garden/config.yml) and resolves project names.
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

function requireHome(): string {
  const h = process.env.HOME ?? process.env.USERPROFILE;
  if (!h) throw new Error("Cannot determine home directory: neither HOME nor USERPROFILE is set.");
  return h;
}
const HOME = requireHome();
export const GARDEN_DIR = path.join(HOME, ".garden");
export const CONFIG_PATH = path.join(GARDEN_DIR, "config.yml");
export const SESSIONS_DIR = path.join(GARDEN_DIR, "sessions");

export interface ProjectConfig {
  path: string;
  baseBranch?: string;
  checks?: string;
  postMerge?: string;
  focused?: boolean;
  sandboxDomains?: string[];
  claudeProfile?: string;
}

const VALID_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "path", "baseBranch", "checks", "postMerge", "focused", "sandboxDomains", "claudeProfile",
]);

export function isValidConfigKey(key: string): boolean {
  return VALID_CONFIG_KEYS.has(key);
}

export interface ClaudeProfile {
  configDir: string;
  label?: string;
}

export interface ResolvedClaudeProfile {
  name: string;
  configDir: string;
  label: string;
}

export type LogsMode = "pretty" | "raw";

export interface LogsConfig {
  mode?: LogsMode;
}

export interface GardenConfig {
  projects: Record<string, ProjectConfig>;
  claudeProfiles?: Record<string, ClaudeProfile>;
  logs?: LogsConfig;
}

export function getLogsMode(config?: GardenConfig): LogsMode {
  const cfg = config ?? loadConfig();
  return cfg.logs?.mode === "raw" ? "raw" : "pretty";
}

export function setLogsMode(mode: LogsMode): void {
  const cfg = loadConfig();
  cfg.logs = { ...(cfg.logs ?? {}), mode };
  saveConfig(cfg);
}

export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

export function resolveClaudeProfile(
  project: Pick<ProjectConfig, "claudeProfile">,
  config?: GardenConfig,
): ResolvedClaudeProfile | null {
  const name = project.claudeProfile;
  if (!name) return null;
  const cfg = config ?? loadConfig();
  const profile = cfg.claudeProfiles?.[name];
  if (!profile) {
    throw new Error(
      `Project references unknown claudeProfile '${name}'. Run 'garden claude-profile add ${name}' or change the project config.`,
    );
  }
  return {
    name,
    configDir: expandHome(profile.configDir),
    label: profile.label ?? name,
  };
}

export function tryResolveClaudeProfile(
  project: Pick<ProjectConfig, "claudeProfile">,
  config?: GardenConfig,
): ResolvedClaudeProfile | null {
  try {
    return resolveClaudeProfile(project, config);
  } catch {
    return null;
  }
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
  const tmpFile = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
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
export function getFocusedProjectNames(config?: GardenConfig): string[] {
  const cfg = config ?? loadConfig();
  return Object.keys(cfg.projects).filter(
    name => cfg.projects[name].focused !== false
  );
}

export function reorderProject(config: GardenConfig, name: string, position: number): void {
  const keys = Object.keys(config.projects);
  if (!keys.includes(name)) throw new Error(`Unknown project: ${name}`);
  const index = position - 1;
  if (index < 0 || index >= keys.length) {
    throw new Error(`Position must be 1-${keys.length}`);
  }
  const filtered = keys.filter(k => k !== name);
  filtered.splice(index, 0, name);
  const reordered: Record<string, ProjectConfig> = {};
  for (const k of filtered) reordered[k] = config.projects[k];
  config.projects = reordered;
}

export function detectProjectFromPath(dir?: string): string | undefined {
  try {
    const config = loadConfig();
    const target = dir ?? process.cwd();
    let bestName: string | undefined;
    let bestLen = 0;
    for (const [name, project] of Object.entries(config.projects)) {
      if (target === project.path || target.startsWith(project.path + "/")) {
        if (project.path.length > bestLen) {
          bestLen = project.path.length;
          bestName = name;
        }
      }
    }
    return bestName;
  } catch {
    // Config not initialized yet
  }
  return undefined;
}
