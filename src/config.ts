// Reads and writes the global garden config (~/.garden/config.yml) and resolves project names.
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { atomicWriteFile } from "./dashboard/atomic-write.js";
import { withFileLock } from "./dashboard/file-lock.js";
import {
  ASSIGNABLE_LOG_COLOR_KEYS,
  RESERVED_LOG_COLOR_KEY,
  RESERVED_LOG_COLOR_PROJECT,
  isValidLogColorKey,
  pickLogColor,
} from "./log-palette.js";

function requireHome(): string {
  const h = process.env.HOME ?? process.env.USERPROFILE;
  if (!h) throw new Error("Cannot determine home directory: neither HOME nor USERPROFILE is set.");
  return h;
}
const HOME = requireHome();
export const GARDEN_DIR = path.join(HOME, ".garden");
export const CONFIG_PATH = path.join(GARDEN_DIR, "config.yml");
export const SESSIONS_DIR = path.join(GARDEN_DIR, "sessions");

export const PLOT_MAX_PROJECTS = 9;
export const DEFAULT_PLOT = "all";

export interface ProjectConfig {
  path: string;
  checks?: string;
  postMerge?: string;
  sandboxDomains?: string[];
  claudeProfile?: string;
  logColor?: string;
  // Trellis workflow keys. See WORKFLOWS.md "Project config".
  // Directory containing trellis files. Resolved relative to the project
  // root. Default: ".garden/trellises".
  trellisDir?: string;
  // Iteration cap on a vine. Per-worker `--max-iterations` overrides this.
  // Default: 30.
  maxTrellisIterations?: number;
  // When true (default), Sonnet exhaustion routes the next iteration through
  // Opus and fires one alert per Sonnet reset window. When false, Sonnet
  // exhaustion pauses the loop via the existing usage-pause mechanism.
  trellisOpusFallback?: boolean;
}

const VALID_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "path", "checks", "postMerge", "sandboxDomains", "claudeProfile", "logColor",
  "trellisDir", "maxTrellisIterations", "trellisOpusFallback",
]);

export function isValidConfigKey(key: string): boolean {
  return VALID_CONFIG_KEYS.has(key);
}

export interface PlotConfig {
  projects: string[];
  focused?: boolean;
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

// Post-merge auto-continue gate. `enabled` may be flipped automatically by the
// poller when a usage meter crosses `usageThreshold`; in that case `pausedUntil`
// records the latest resetsAt of the meters that tripped, and `pausedReason`
// is a human-readable summary. If `resumeAfterReset` is true the gate auto-flips
// `enabled` back on once `pausedUntil` is in the past. Sonnet usage is
// intentionally excluded from the threshold check (Opus is the workhorse).
export interface AutoContinueConfig {
  enabled: boolean;
  usageThreshold: number;
  resumeAfterReset: boolean;
  pausedUntil?: string;
  pausedReason?: string;
}

export const AUTO_CONTINUE_DEFAULTS: AutoContinueConfig = {
  enabled: true,
  usageThreshold: 95,
  resumeAfterReset: false,
};

export interface GardenConfig {
  projects: Record<string, ProjectConfig>;
  plots?: Record<string, PlotConfig>;
  claudeProfiles?: Record<string, ClaudeProfile>;
  logs?: LogsConfig;
  autoContinue?: Partial<AutoContinueConfig>;
}

export function getAutoContinueConfig(config?: GardenConfig): AutoContinueConfig {
  const cfg = config ?? loadConfig();
  return { ...AUTO_CONTINUE_DEFAULTS, ...(cfg.autoContinue ?? {}) };
}

export function setAutoContinueConfig(patch: Partial<AutoContinueConfig>): AutoContinueConfig {
  // Lock-protected R/M/W: the poller's threshold-tripping write
  // (autoContinueGateReason) races with operator commands like
  // `garden auto on` if both load the file before either saves.
  return withConfigLock(() => {
    const cfg = loadConfig();
    const merged: AutoContinueConfig = { ...getAutoContinueConfig(cfg), ...patch };
    // Strip pause metadata when not paused so the file stays clean.
    const persisted: Partial<AutoContinueConfig> = { ...merged };
    if (persisted.pausedUntil === undefined) delete persisted.pausedUntil;
    if (persisted.pausedReason === undefined) delete persisted.pausedReason;
    cfg.autoContinue = persisted;
    saveConfig(cfg);
    return merged;
  });
}

export function getLogsMode(config?: GardenConfig): LogsMode {
  const cfg = config ?? loadConfig();
  return cfg.logs?.mode === "raw" ? "raw" : "pretty";
}

export function setLogsMode(mode: LogsMode): void {
  withConfigLock(() => {
    const cfg = loadConfig();
    cfg.logs = { ...(cfg.logs ?? {}), mode };
    saveConfig(cfg);
  });
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
  const parsed = (yaml.load(raw) as GardenConfig | null) ?? { projects: {} };
  if (!parsed.projects) parsed.projects = {};
  let dirty = false;
  if (migratePlots(parsed)) dirty = true;
  if (migrateLogColors(parsed)) dirty = true;
  if (dirty) saveConfig(parsed);
  return parsed;
}

// One-shot migration: assign a logColor to any project missing or holding an
// unknown key. Garden is excluded (always painted via the reserved slot).
function migrateLogColors(config: GardenConfig): boolean {
  let changed = false;
  const taken: string[] = [];
  for (const [name, project] of Object.entries(config.projects)) {
    if (name === RESERVED_LOG_COLOR_PROJECT) continue;
    if (project.logColor && isValidLogColorKey(project.logColor)
      && project.logColor !== RESERVED_LOG_COLOR_KEY) {
      taken.push(project.logColor);
    }
  }
  for (const [name, project] of Object.entries(config.projects)) {
    if (name === RESERVED_LOG_COLOR_PROJECT) {
      if (project.logColor) {
        delete project.logColor;
        changed = true;
      }
      continue;
    }
    if (!project.logColor || !isValidLogColorKey(project.logColor)
      || project.logColor === RESERVED_LOG_COLOR_KEY) {
      const next = pickLogColor(taken);
      project.logColor = next;
      taken.push(next);
      changed = true;
    }
  }
  return changed;
}

// Mutates config in place; caller is responsible for `saveConfig`.
export function assignLogColor(config: GardenConfig, projectName: string): void {
  if (projectName === RESERVED_LOG_COLOR_PROJECT) return;
  const project = config.projects[projectName];
  if (!project) return;
  if (project.logColor && isValidLogColorKey(project.logColor)
    && project.logColor !== RESERVED_LOG_COLOR_KEY) return;
  const taken: string[] = [];
  for (const [name, p] of Object.entries(config.projects)) {
    if (name === projectName) continue;
    if (p.logColor && isValidLogColorKey(p.logColor)
      && p.logColor !== RESERVED_LOG_COLOR_KEY) {
      taken.push(p.logColor);
    }
  }
  project.logColor = pickLogColor(taken);
}

export function logColorKeyForProject(
  projectName: string,
  config?: GardenConfig,
): string | null {
  if (projectName === RESERVED_LOG_COLOR_PROJECT) return RESERVED_LOG_COLOR_KEY;
  const cfg = config ?? loadConfig();
  const project = cfg.projects[projectName];
  if (!project) return null;
  const key = project.logColor;
  if (!key || !isValidLogColorKey(key) || key === RESERVED_LOG_COLOR_KEY) return null;
  return key;
}

export { ASSIGNABLE_LOG_COLOR_KEYS };

// One-shot migration: when a config predates plots, synthesize `all` from
// currently focused projects and strip the now-unused `focused` project flag.
// Idempotent — re-running on a migrated config is a no-op.
function migratePlots(config: GardenConfig): boolean {
  if (config.plots) return false;
  const focusedNames = Object.keys(config.projects).filter(
    name => (config.projects[name] as ProjectConfig & { focused?: boolean }).focused !== false,
  );
  config.plots = { [DEFAULT_PLOT]: { projects: focusedNames } };
  for (const project of Object.values(config.projects)) {
    delete (project as ProjectConfig & { focused?: boolean }).focused;
  }
  return true;
}

export function saveConfig(config: GardenConfig): void {
  atomicWriteFile(CONFIG_PATH, yaml.dump(config, { lineWidth: -1 }));
}

const CONFIG_LOCK_FILE = `${CONFIG_PATH}.lock`;

// Serialize read-modify-write cycles on the config file. Used by writers
// that cannot tolerate a lost-update race against another writer (notably
// the poller's auto-continue threshold-trip vs. operator `garden auto on`).
// Most operator commands don't need this — they're invoked sequentially by
// a human, and an interleaved write is implausible.
export function withConfigLock<T>(fn: () => T): T {
  return withFileLock(CONFIG_LOCK_FILE, fn, { name: "config" });
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
 * Project names visible in the dashboard, in the order ⌥1–⌥N should index them.
 * Resolution: the active plot if set and valid; otherwise the first focused plot;
 * otherwise the DEFAULT_PLOT ("all"). Stale project names are defensively filtered.
 */
export function getFocusedProjectNames(
  config?: GardenConfig,
  activePlot?: string | null,
): string[] {
  const cfg = config ?? loadConfig();
  const plots = cfg.plots ?? {};
  const plotName =
    (activePlot && plots[activePlot] ? activePlot : null) ??
    firstFocusedPlotName(cfg) ??
    (plots[DEFAULT_PLOT] ? DEFAULT_PLOT : null);
  if (!plotName) return [];
  const plot = plots[plotName];
  return plot.projects.filter(n => n in cfg.projects);
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

// ---------------------------------------------------------------------------
// Plots: CRUD + validation
// ---------------------------------------------------------------------------

export function plotsMap(config: GardenConfig): Record<string, PlotConfig> {
  if (!config.plots) config.plots = {};
  return config.plots;
}

export function plotNames(config: GardenConfig): string[] {
  return Object.keys(plotsMap(config));
}

export function getPlot(config: GardenConfig, name: string): PlotConfig {
  const plot = plotsMap(config)[name];
  if (!plot) {
    throw new Error(`Unknown plot: ${name}. Run 'garden plot' to see plots.`);
  }
  return plot;
}

export function tryGetPlot(config: GardenConfig, name: string): PlotConfig | null {
  return plotsMap(config)[name] ?? null;
}

export function isPlotFocused(plot: PlotConfig): boolean {
  return plot.focused !== false;
}

export function firstFocusedPlotName(config: GardenConfig): string | null {
  for (const [name, plot] of Object.entries(plotsMap(config))) {
    if (isPlotFocused(plot)) return name;
  }
  return null;
}

function assertPlotName(name: string): void {
  if (!name || /\s/.test(name)) {
    throw new Error(`Invalid plot name: '${name}'. Use a short, whitespace-free identifier.`);
  }
}

function assertProjectsExist(config: GardenConfig, names: string[]): void {
  for (const n of names) {
    if (!config.projects[n]) {
      throw new Error(`Unknown project: ${n}. Run 'garden list' to see projects.`);
    }
  }
}

export function createPlot(config: GardenConfig, name: string, projects: string[]): void {
  assertPlotName(name);
  if (plotsMap(config)[name]) {
    throw new Error(`Plot '${name}' already exists.`);
  }
  if (projects.length > PLOT_MAX_PROJECTS) {
    throw new Error(`Plot '${name}' exceeds the ${PLOT_MAX_PROJECTS}-project limit.`);
  }
  assertProjectsExist(config, projects);
  const deduped = [...new Set(projects)];
  plotsMap(config)[name] = { projects: deduped };
}

export function deletePlot(config: GardenConfig, name: string): void {
  if (!plotsMap(config)[name]) {
    throw new Error(`Unknown plot: ${name}.`);
  }
  delete plotsMap(config)[name];
}

export function renamePlot(config: GardenConfig, oldName: string, newName: string): void {
  assertPlotName(newName);
  const plots = plotsMap(config);
  if (!plots[oldName]) throw new Error(`Unknown plot: ${oldName}.`);
  if (plots[newName]) throw new Error(`Plot '${newName}' already exists.`);
  const rebuilt: Record<string, PlotConfig> = {};
  for (const [k, v] of Object.entries(plots)) {
    rebuilt[k === oldName ? newName : k] = v;
  }
  config.plots = rebuilt;
}

export function addProjectToPlot(
  config: GardenConfig,
  plotName: string,
  projectName: string,
  position?: number,
): void {
  const plot = getPlot(config, plotName);
  assertProjectsExist(config, [projectName]);
  if (plot.projects.includes(projectName)) {
    throw new Error(`Project '${projectName}' is already in plot '${plotName}'.`);
  }
  if (plot.projects.length >= PLOT_MAX_PROJECTS) {
    throw new Error(`Plot '${plotName}' is full (${PLOT_MAX_PROJECTS}).`);
  }
  if (position == null) {
    plot.projects.push(projectName);
    return;
  }
  const idx = position - 1;
  if (idx < 0 || idx > plot.projects.length) {
    throw new Error(`Position must be 1-${plot.projects.length + 1}.`);
  }
  plot.projects.splice(idx, 0, projectName);
}

export function removeProjectFromPlot(
  config: GardenConfig,
  plotName: string,
  projectName: string,
): void {
  const plot = getPlot(config, plotName);
  const idx = plot.projects.indexOf(projectName);
  if (idx === -1) {
    throw new Error(`Project '${projectName}' is not in plot '${plotName}'.`);
  }
  plot.projects.splice(idx, 1);
}

export function reorderProjectInPlot(
  config: GardenConfig,
  plotName: string,
  projectName: string,
  position: number,
): void {
  const plot = getPlot(config, plotName);
  const idx = plot.projects.indexOf(projectName);
  if (idx === -1) {
    throw new Error(`Project '${projectName}' is not in plot '${plotName}'.`);
  }
  const target = position - 1;
  if (target < 0 || target >= plot.projects.length) {
    throw new Error(`Position must be 1-${plot.projects.length}.`);
  }
  plot.projects.splice(idx, 1);
  plot.projects.splice(target, 0, projectName);
}

export function reorderPlotInCycle(
  config: GardenConfig,
  plotName: string,
  position: number,
): void {
  const plots = plotsMap(config);
  const keys = Object.keys(plots);
  if (!keys.includes(plotName)) throw new Error(`Unknown plot: ${plotName}.`);
  const target = position - 1;
  if (target < 0 || target >= keys.length) {
    throw new Error(`Position must be 1-${keys.length}.`);
  }
  const filtered = keys.filter(k => k !== plotName);
  filtered.splice(target, 0, plotName);
  const rebuilt: Record<string, PlotConfig> = {};
  for (const k of filtered) rebuilt[k] = plots[k];
  config.plots = rebuilt;
}

export function setPlotFocused(
  config: GardenConfig,
  plotName: string,
  focused: boolean,
): void {
  const plot = getPlot(config, plotName);
  if (focused) delete plot.focused;
  else plot.focused = false;
}

export function purgeProjectFromPlots(config: GardenConfig, projectName: string): void {
  for (const plot of Object.values(plotsMap(config))) {
    plot.projects = plot.projects.filter(n => n !== projectName);
  }
}
