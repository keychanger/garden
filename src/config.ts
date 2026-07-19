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
  // Branch this project's workers merge into. When set, it is the
  // authoritative base for every new worker (see resolveSpawnBase in
  // dashboard/git.ts) — `workers new --base` overrides per worker, and the
  // status pane treats a worker whose pinned base differs from this as a
  // deliberate override (a grey badge) rather than the "checkout drifted"
  // warning. Unset (the legacy default) means workers follow whatever branch
  // the project checkout is on at spawn time. See docs/future/OPERATOR-UI.md
  // Part 2 + PROJECT-CUSTOMIZATION.md A1.3.
  baseBranch?: string;
  checks?: string;
  postMerge?: string;
  sandboxDomains?: string[];
  claudeProfile?: string;
  // Model provider for this project's WORKERS (see docs/MULTI-MODEL.md
  // "Layer 1"). Names an entry in GardenConfig.providers. Reviewer,
  // resolver, and ci-fix agents deliberately ignore this key — they stay
  // on the first-party Anthropic path (claudeProfile or personal) so a
  // cheap/experimental worker model is always reviewed by a strong one.
  provider?: string;
  // Default worker harness (agent CLI) for this project's workers — the axis-2
  // analog of `provider` (axis 1). Absent = "claude-code". `workers new
  // --harness` overrides per worker; a crew sets this alongside the review
  // roles. Only the WORKER default lives here; the review family selects its
  // harness under `roles` (a provider never reaches review — the safety net).
  // See crew.ts + docs/future/CREWS.md.
  harness?: string;
  // Default worker model for this project's DEFAULT and GROW workers — the
  // project-level analog of `workers new --model` (which overrides it per
  // spawn), resolved beneath it in newWorker (per-spawn > project > account
  // default), exactly as `baseBranch` sits beneath `--base`. Opaque string:
  // an Anthropic alias resolved through the provider modelMap on a
  // provider-backed project, or a concrete model id. Ignored by trellis
  // (resolves its own model per iteration) and by the review family (stays on
  // the strong first-party default). The ultracode preset's Opus pin still
  // wins over this (it is the more specific per-spawn gesture).
  model?: string;
  // Default reasoning effort for this project's DEFAULT and GROW workers — the
  // project-level analog of `workers new --effort`, resolved beneath it in
  // newWorker. One of WORKER_EFFORT_LEVELS (low/medium/high/xhigh) rendered as
  // `--effort <level>`, or "ultra" for the ultracode preset (max effort +
  // dynamic workflows). Ignored by trellis and suppressed when a spawn resolves
  // to ultracode. See WORKER_EFFORT_LEVELS (dashboard/create.ts).
  effort?: string;
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
  // Iteration cap on a grow loop. Per-worker `--max-iterations` overrides
  // this. Default: 5 (grow loops are typically short polish passes;
  // operators who want longer convergence should use a trellis instead).
  maxGrowIterations?: number;
  // CI gate at the poller's merge step. When true (default) the poller
  // queries GitHub Actions check-runs on the worker's HEAD before each
  // merge — pending defers the merge, failure parks the worker in
  // `failing` with reason "ci", success (or no check-runs on a project
  // without CI) proceeds. Zero check-runs on a project the poller has
  // observed run CI defer briefly first, in case they haven't materialized.
  // Set to false on projects whose CI is irrelevant to merge
  // safety (no workflow, advisory-only, or being intentionally bypassed).
  // See `src/dashboard/poller-ci.ts`.
  requireCiSuccess?: boolean;
  // Holistic post-merge review mode for this project. When a multi-phase
  // default worker (>=2 merges) reaches `done`, the poller may dispatch one
  // whole-task coherence review:
  //   "off"    — evaluate the gate and log the decision, never spawn.
  //   "shadow" — spawn an analyze-only reviewer that writes findings + a warn
  //              alert and pushes nothing.
  //   "fix"    (default, DEFAULT_HOLISTIC_REVIEW) — spawn a reviewer that fixes
  //              genuine cross-phase defects and pushes through the normal
  //              review/CI/merge gate.
  // Read live per poll, so it doubles as a no-restart kill switch: a project
  // that wants the older opt-in behavior sets "off" or "shadow" explicitly.
  holisticReview?: "off" | "shadow" | "fix";
  // Per-role overrides for the review family (reviewer / resolver / ci-fix).
  // Each role independently resolves its harness + model; unset falls back to
  // the safe default (claude-code + Opus). This is how Codex-as-reviewer is
  // selected: `garden config <p> role reviewer harness codex`. Only harness +
  // model in v1 — a provider on a review role only ever defeats the safety
  // net, and the worker keeps the flat `provider` key. See resolveReviewRole
  // (dashboard/roles.ts) + docs/MULTI-MODEL.md "Phase 4".
  roles?: {
    reviewer?: RoleTarget;
    resolver?: RoleTarget;
    ciFix?: RoleTarget;
  };
}

// One review role's harness/model selection. Both optional — an absent
// dimension resolves through the default chain in resolveReviewRole.
export interface RoleTarget {
  harness?: string;
  model?: string;
}

// The effective holisticReview mode for a project that hasn't set the key.
// Operator decision (2026-07-16): every multi-phase task gets an auto-fixing
// whole-task coherence review by default; a project opts out with an explicit
// "off"/"shadow". Single source of truth for the poller gate + the ⌥, menu.
export const DEFAULT_HOLISTIC_REVIEW = "fix";

const VALID_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "path", "baseBranch", "checks", "postMerge", "sandboxDomains", "claudeProfile", "provider",
  "harness", "model", "effort", "logColor", "trellisDir", "maxTrellisIterations",
  "trellisOpusFallback", "maxGrowIterations", "requireCiSuccess", "holisticReview",
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

// A model provider: an Anthropic-Messages-compatible backend that the
// unchanged Claude Code harness reaches by swapping the ANTHROPIC_* env
// surface (DeepSeek's /anthropic endpoint, a local Ollama, a gateway).
// See docs/MULTI-MODEL.md "Layer 1: provider descriptors".
//
// Providers are API-key-backed by construction: the credential is named by
// env var, never a Claude OAuth blob. This is the structural form of the
// subscription-credential rule — a Claude subscription OAuth credential
// (claudeProfile / personal) can only ever target the default Anthropic
// endpoint, because providers have no field that could reference one.
export interface ProviderProfile {
  // ANTHROPIC_BASE_URL for sessions on this provider. http(s) URL.
  baseUrl: string;
  // NAME of the env var holding the API key (e.g. "DEEPSEEK_API_KEY").
  // The key value itself never enters config.yml or a tmux command line:
  // launch commands interpolate `ANTHROPIC_AUTH_TOKEN="$<name>"` and the
  // pane shell expands it at spawn time. Must match ENV_VAR_NAME_RE —
  // that regex is the injection guard for the unquoted interpolation.
  authTokenEnv: string;
  label?: string;
  // What the opus/sonnet/haiku model aliases resolve to on this backend
  // (ANTHROPIC_DEFAULT_*_MODEL). Unset aliases fall through to the
  // provider's own server-side default mapping.
  modelMap?: { opus?: string; sonnet?: string; haiku?: string };
  // Extra sandbox egress hosts beyond the baseUrl host (which is allowed
  // automatically). For Ollama Cloud e.g. ["ollama.com"].
  egressHosts?: string[];
}

export interface ResolvedProvider extends ProviderProfile {
  name: string;
  label: string;
}

export const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const MODEL_MAP_KEYS = ["opus", "sonnet", "haiku"] as const;

// Shared by `garden provider add` (CLI input) and resolveProvider (defense
// against hand-edited config.yml — authTokenEnv is interpolated into shell
// commands, so an invalid name must fail loudly at resolve time, not spawn
// a worker with a malformed env assignment).
export function assertValidProvider(name: string, p: ProviderProfile): void {
  if (!PROVIDER_NAME_RE.test(name)) {
    throw new Error(`Provider name must be alphanumeric/dash/underscore: ${name}`);
  }
  let url: URL;
  try {
    url = new URL(p.baseUrl);
  } catch {
    throw new Error(`Provider '${name}': baseUrl is not a valid URL: ${p.baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Provider '${name}': baseUrl must be http(s), got ${url.protocol}//`);
  }
  if (!ENV_VAR_NAME_RE.test(p.authTokenEnv)) {
    throw new Error(
      `Provider '${name}': authTokenEnv must be an env var name (A-Z, 0-9, _), got '${p.authTokenEnv}'`,
    );
  }
  for (const key of Object.keys(p.modelMap ?? {})) {
    if (!MODEL_MAP_KEYS.includes(key as typeof MODEL_MAP_KEYS[number])) {
      throw new Error(
        `Provider '${name}': unknown modelMap alias '${key}'. Valid: ${MODEL_MAP_KEYS.join(", ")}`,
      );
    }
  }
  for (const host of p.egressHosts ?? []) {
    if (!host || /\s|\//.test(host)) {
      throw new Error(
        `Provider '${name}': egressHosts entries must be bare hostnames, got '${host}'`,
      );
    }
  }
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

// Machine-wide (garden-level, not per-project) resource budgets. The
// workstation garden runs on is a single shared resource, so these knobs
// belong here rather than on any one project: no project would sensibly want a
// different value for "how much of MY machine may the fleet use". Both are
// optional overrides of a safe default — an absent `limits` block is the shipped
// behavior. See `garden limits` (commands/limits.ts).
export interface LimitsConfig {
  // Concurrent checks-suite runs admitted by the machine-wide checks
  // semaphore (src/checks-semaphore.ts). Overrides the hardware-derived
  // default (defaultChecksSlots() = max(1, cores/8)). >= 1.
  checksSlots?: number;
  // Fleet-wide cap on simultaneously running headless reviewers (live
  // `_<project>-review-<worker>` windows across all projects). When the cap is
  // reached, a project poller defers launching the next per-phase review
  // (re-poking so it retries) rather than oversubscribing the machine with
  // parallel reviewer inference. Resolvers and ci-fix agents are deliberately
  // uncapped — they unblock already-in-flight merges, so capping them could
  // deadlock the pipeline. 0 or unset = unlimited (the shipped behavior).
  maxConcurrentReviews?: number;
}

export interface GardenConfig {
  projects: Record<string, ProjectConfig>;
  plots?: Record<string, PlotConfig>;
  claudeProfiles?: Record<string, ClaudeProfile>;
  providers?: Record<string, ProviderProfile>;
  logs?: LogsConfig;
  autoContinue?: Partial<AutoContinueConfig>;
  limits?: LimitsConfig;
}

// The effective review cap: 0 means unlimited. Read by the poller's
// review-launch gate (handleWorking).
export function getMaxConcurrentReviews(config?: GardenConfig): number {
  const cfg = config ?? loadConfig();
  const n = cfg.limits?.maxConcurrentReviews;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// The configured checks-slot override, or undefined to use the hardware
// default. Read by `garden checks` (commands/checks.ts).
export function getChecksSlotsOverride(config?: GardenConfig): number | undefined {
  const cfg = config ?? loadConfig();
  const n = cfg.limits?.checksSlots;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

// Lock-protected R/M/W of a single limits key. Passing undefined clears it.
// Returns the merged LimitsConfig.
export function setLimit(key: keyof LimitsConfig, value: number | undefined): LimitsConfig {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const limits: LimitsConfig = { ...(cfg.limits ?? {}) };
    if (value === undefined) delete limits[key];
    else limits[key] = value;
    if (Object.keys(limits).length === 0) delete cfg.limits;
    else cfg.limits = limits;
    saveConfig(cfg);
    return limits;
  });
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

export function resolveProvider(
  project: Pick<ProjectConfig, "provider">,
  config?: GardenConfig,
): ResolvedProvider | null {
  const name = project.provider;
  if (!name) return null;
  const cfg = config ?? loadConfig();
  const provider = cfg.providers?.[name];
  if (!provider) {
    throw new Error(
      `Project references unknown provider '${name}'. Run 'garden provider add ${name}' or change the project config.`,
    );
  }
  assertValidProvider(name, provider);
  return {
    ...provider,
    name,
    label: provider.label ?? name,
  };
}

// Mirrors tryResolveClaudeProfile: launch paths (dashboard attach, resume,
// bounce) must not abort wholesale on a hand-broken config entry, so they
// fall back to the first-party Anthropic path. `garden config <project>
// provider` validates at set time, which makes this fallback unreachable
// through the CLI.
export function tryResolveProvider(
  project: Pick<ProjectConfig, "provider">,
  config?: GardenConfig,
): ResolvedProvider | null {
  try {
    return resolveProvider(project, config);
  } catch {
    return null;
  }
}

// True when at least one registered project runs on the first-party
// Anthropic path (no `provider` key) — i.e. the Claude OAuth usage meter
// has something to meter. A provider-only fleet must not poll the OAuth
// usage endpoint or render quota bars that describe nothing.
// Zero projects counts as metered: a fresh install defaults to Anthropic.
export function anyAnthropicMeteredProject(config?: GardenConfig): boolean {
  const cfg = config ?? loadConfig();
  const projects = Object.values(cfg.projects);
  if (projects.length === 0) return true;
  return projects.some((p) => !p.provider);
}

// True when a project's workers draw tokens from a pool the default-account
// usage meters do not describe: a third-party `provider`, or a claudeProfile
// resolving to a config dir other than the default ~/.claude (a separate
// Claude subscription). The auto-continue usage gate skips such projects —
// pausing them on the default account's meters would strand work whose
// tokens those meters never counted. This must mirror `workerEnvPrefix`
// (claude-env.ts), which picks the pool the worker actually launches on.
// Fails closed: an unknown project counts as metered; a configured-but-
// unresolvable provider is NOT exempt on its own — like workerEnvPrefix it
// falls back to the first-party path, so it falls through to the profile
// check (default ~/.claude → metered); an unresolvable profile also counts
// as metered. The gate then still applies unless the worker genuinely runs
// on a non-default pool.
export function projectUsageGateExempt(projectName: string, config?: GardenConfig): boolean {
  const cfg = config ?? loadConfig();
  const project = cfg.projects[projectName];
  if (!project) return false;
  if (project.provider && tryResolveProvider(project, cfg)) return true;
  if (!project.claudeProfile) return false;
  const profile = tryResolveClaudeProfile(project, cfg);
  if (!profile) return false;
  return path.resolve(profile.configDir) !== path.resolve(HOME, ".claude");
}

export function loadConfig(): GardenConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      "Garden is not initialized. Run 'garden init' first."
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  let loaded: unknown;
  try {
    loaded = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse garden config at ${CONFIG_PATH}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // An empty file parses to null/undefined — that is a fresh config, not a
  // fault. Anything else non-object (a bare scalar from a truncated or garbled
  // write) is a corrupt file: assigning `.projects` onto it throws an opaque
  // TypeError under ESM strict mode, so reject it with the same clear message
  // as a syntax error.
  if (loaded !== null && loaded !== undefined && typeof loaded !== "object") {
    throw new Error(
      `Failed to parse garden config at ${CONFIG_PATH}: ` +
      `expected a YAML mapping, got ${typeof loaded}`,
    );
  }
  const parsed = (loaded as GardenConfig | null) ?? { projects: {} };
  if (!parsed.projects) parsed.projects = {};
  let dirty = false;
  if (migratePlots(parsed)) dirty = true;
  if (migrateLogColors(parsed)) dirty = true;
  if (dirty) {
    // loadConfig is a read path — hotkey plot cycling, the poller, and every
    // command call it — so a bare unlocked save here turns every reader into a
    // writer that can clobber a concurrent operator or poller config write
    // (e.g. the poller's auto-continue threshold trip). Persist the one-time,
    // idempotent migration only when the config lock is free, and skip on
    // contention: it re-runs harmlessly on the next load, and whoever holds the
    // lock persists the migrated shape via its own save. The short deadline also
    // avoids a re-entrant self-deadlock when loadConfig runs inside a
    // withConfigLock'd mutation (setAutoContinueConfig / setLogsMode).
    try {
      withFileLock(CONFIG_LOCK_FILE, () => saveConfig(parsed), { deadlineMs: 250, name: "config-migrate" });
    } catch {
      /* lock contended or self-held — migration persists on a later load */
    }
  }
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

/**
 * Deduplicated union of every plot's projects, in first-seen order across
 * plots. Stale project names are defensively filtered, matching
 * getFocusedProjectNames. Used by `garden status --all` to report workers
 * across all plots in one invocation rather than only the active plot.
 */
export function allPlotProjectNames(config?: GardenConfig): string[] {
  const cfg = config ?? loadConfig();
  const plots = cfg.plots ?? {};
  const seen = new Set<string>();
  const names: string[] = [];
  for (const plot of Object.values(plots)) {
    for (const name of plot.projects) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (name in cfg.projects) names.push(name);
    }
  }
  return names;
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
