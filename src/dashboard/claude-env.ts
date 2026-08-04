import { createHash } from "node:crypto";
import {
  tryResolveClaudeProfile, tryResolveProvider, resolveProvider, ENV_VAR_NAME_RE,
  type ProjectConfig, type GardenConfig, type ResolvedProvider,
} from "../config.js";
import { shellEscape, tmux, tmuxOutput, tmuxWithHiddenEnvironment } from "./tmux.js";
import { DASHBOARD_SESSION, dashboardExists } from "../session.js";
import { log } from "./log.js";
import type { WorkerLaunchPlan } from "./harness/types.js";

export function claudeConfigDirFor(
  project: Pick<ProjectConfig, "claudeProfile">,
  config?: GardenConfig,
): string | null {
  const profile = tryResolveClaudeProfile(project, config);
  return profile?.configDir ?? null;
}

// First-party Anthropic env: the claudeProfile's CLAUDE_CONFIG_DIR, or empty
// for the personal account. This is the only env the reviewer/resolver/ci-fix
// launch paths use — headless agents stay on the Anthropic path regardless of
// the project's worker provider (see docs/MULTI-MODEL.md "Mixed fleets").
export function claudeEnvPrefix(
  project: Pick<ProjectConfig, "claudeProfile">,
  config?: GardenConfig,
): string {
  const dir = claudeConfigDirFor(project, config);
  return dir ? `CLAUDE_CONFIG_DIR=${shellEscape(dir)} ` : "";
}

export function claudeEnvObject(
  project: Pick<ProjectConfig, "claudeProfile">,
  config?: GardenConfig,
): Record<string, string> {
  const dir = claudeConfigDirFor(project, config);
  return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
}

// Legacy/best-effort worker env helper. Production launch boundaries derive
// this once in resolveWorkerLaunchPlan, which resolves providers strictly.
export function workerEnvPrefix(
  project: Pick<ProjectConfig, "claudeProfile" | "provider">,
  config?: GardenConfig,
): string {
  const provider = tryResolveProvider(project, config);
  if (provider) return providerEnvPrefix(provider);
  // Best-effort callers retain the historical loud fallback. Launch callers
  // never reach it: resolveWorkerLaunchPlan rejects the invalid identity.
  if (project.provider) {
    log.warn("provider", "provider failed to resolve; worker falling back to the first-party Anthropic path", {
      data: { provider: project.provider },
    });
  }
  return claudeEnvPrefix(project, config);
}

// Env prefix for the REVIEWER / RESOLVER / CI-FIX agents: always the
// first-party Anthropic path. For provider-backed projects this actively
// neutralizes any provider env inherited from the tmux server (an operator
// following DeepSeek/Ollama setup guides may have ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN exported globally) — without the explicit empties,
// the Opus-pinned reviewer would silently run against the worker's cheap
// backend and the safety net would evaporate exactly when it matters.
// Claude Code treats empty-string values as unset. Non-provider projects
// get the plain claudeProfile env, preserving any intentional global
// gateway setups outside garden's provider model.
export function reviewerEnvPrefix(
  project: Pick<ProjectConfig, "claudeProfile" | "provider">,
  config?: GardenConfig,
): string {
  const onProvider = tryResolveProvider(project, config) !== null;
  const neutralize = onProvider
    ? "ANTHROPIC_BASE_URL='' ANTHROPIC_AUTH_TOKEN='' ANTHROPIC_API_KEY='' "
      + "ANTHROPIC_DEFAULT_OPUS_MODEL='' ANTHROPIC_DEFAULT_SONNET_MODEL='' ANTHROPIC_DEFAULT_HAIKU_MODEL='' "
    : "";
  return neutralize + claudeEnvPrefix(project, config);
}

// Object form of reviewerEnvPrefix, for a direct process spawn (spawnSync)
// rather than a shell command. Returns only the OVERRIDES — the neutralized
// provider vars (empty string, which Claude Code treats as unset) plus the
// claudeProfile CLAUDE_CONFIG_DIR — for the caller to merge over process.env.
export function reviewerEnvObject(
  project: Pick<ProjectConfig, "claudeProfile" | "provider">,
  config?: GardenConfig,
): Record<string, string> {
  const onProvider = tryResolveProvider(project, config) !== null;
  const neutralize: Record<string, string> = onProvider
    ? {
        ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "", ANTHROPIC_DEFAULT_SONNET_MODEL: "",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
      }
    : {};
  return { ...neutralize, ...claudeEnvObject(project, config) };
}

// Inline env assignments that point a Claude Code session at a provider's
// Anthropic-compatible endpoint. The command references Garden's internal
// hidden tmux variable, not the operator's authTokenEnv or its value. The
// worker launch queue makes that variable inheritable for this pane only;
// `env -u` removes the vault name before the agent process starts.
export function providerEnvPrefix(provider: ResolvedProvider): string {
  if (!ENV_VAR_NAME_RE.test(provider.authTokenEnv)) {
    throw new Error(
      `Provider '${provider.name}': authTokenEnv '${provider.authTokenEnv}' is not a valid env var name.`,
    );
  }
  const tokenEnv = providerTokenVaultEnv(provider);
  const parts = [
    `ANTHROPIC_BASE_URL=${shellEscape(provider.baseUrl)}`,
    `ANTHROPIC_AUTH_TOKEN="$${tokenEnv}"`,
  ];
  const map = provider.modelMap ?? {};
  if (map.opus) parts.push(`ANTHROPIC_DEFAULT_OPUS_MODEL=${shellEscape(map.opus)}`);
  if (map.sonnet) parts.push(`ANTHROPIC_DEFAULT_SONNET_MODEL=${shellEscape(map.sonnet)}`);
  if (map.haiku) parts.push(`ANTHROPIC_DEFAULT_HAIKU_MODEL=${shellEscape(map.haiku)}`);
  return `${parts.join(" ")} env -u ${tokenEnv} `;
}

// Stable internal name for a provider's token inside tmux. The operator's
// authTokenEnv is config and may collide with ordinary shell state; the
// digest gives Garden a private namespace while keeping the actual key out of
// config, generated commands, and later tmux client argv.
export function providerTokenVaultEnv(provider: ResolvedProvider): string {
  const digest = createHash("sha256")
    .update(provider.name)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `GARDEN_PROVIDER_TOKEN_${digest}`;
}

export function clearProviderTokenVault(provider: ResolvedProvider): void {
  if (!dashboardExists()) return;
  try {
    tmux(
      "set-environment", "-u", "-t", DASHBOARD_SESSION,
      providerTokenVaultEnv(provider),
    );
  } catch (err) {
    log.warn("provider", "failed to remove provider token from hidden tmux state", {
      data: { provider: provider.name, error: String(err) },
    });
  }
}

function legacyProviderToken(authTokenEnv: string): string | undefined {
  try {
    const line = tmuxOutput(
      "show-environment", "-t", DASHBOARD_SESSION, authTokenEnv,
    ).trim();
    if (line.startsWith(`${authTokenEnv}=`)) {
      return line.slice(authTokenEnv.length + 1);
    }
  } catch {
    /* no legacy value */
  }
  return undefined;
}

function storeProviderToken(provider: ResolvedProvider, value: string): boolean {
  const vaultEnv = providerTokenVaultEnv(provider);
  try {
    const cleanup = vaultEnv === provider.authTokenEnv
      ? []
      : [";", "set-environment", "-r", "-t", DASHBOARD_SESSION, provider.authTokenEnv];
    tmux(
      "set-environment", "-h", "-t", DASHBOARD_SESSION, vaultEnv, value,
      ...cleanup,
    );
    return true;
  } catch (err) {
    log.warn("provider", "failed to sync provider token into hidden tmux state", {
      data: { provider: provider.name, envVar: provider.authTokenEnv, error: String(err) },
    });
    return false;
  }
}

// Copy a key from the operator shell into tmux's HIDDEN environment. Hidden
// variables persist for bounce/resume but are not inherited by new panes.
// tmuxWorkerCommand temporarily unveils only the selected provider's variable
// around one worker launch queue. Called from the operator-shell entry points:
// provider add, config set, dashboard create/attach, and workers new.
export function syncProviderTokenToVault(provider: ResolvedProvider): boolean {
  if (!dashboardExists()) return false;
  const value = process.env[provider.authTokenEnv]
    || legacyProviderToken(provider.authTokenEnv);
  // Upgrade bridge: older Garden versions stored authTokenEnv as an ordinary
  // inheritable session variable. Migrate it even when this CLI process was
  // launched without the operator's current shell environment. The `-r`
  // cleanup below leaves a removed marker rather than merely unsetting the
  // session value; otherwise tmux would expose a same-named global value again.
  if (!value) return false;
  return storeProviderToken(provider, value);
}

// Sync every configured provider. This includes currently-unused profiles:
// on upgrade, their source variables may already be ordinary inherited tmux
// state and must be migrated before another pane starts. Snapshot legacy
// values before cleaning any source variable so profiles that intentionally
// share authTokenEnv all receive the value.
export function syncAllProviderTokenVaults(config: GardenConfig): void {
  if (!dashboardExists()) return;
  const providers = Object.keys(config.providers ?? {})
    .map(name => tryResolveProvider({ provider: name }, config))
    .filter((provider): provider is ResolvedProvider => provider !== null);
  const legacyValues = new Map<string, string>();
  for (const provider of providers) {
    if (process.env[provider.authTokenEnv] || legacyValues.has(provider.authTokenEnv)) continue;
    const value = legacyProviderToken(provider.authTokenEnv);
    if (value) legacyValues.set(provider.authTokenEnv, value);
  }
  for (const provider of providers) {
    const value = process.env[provider.authTokenEnv]
      || legacyValues.get(provider.authTokenEnv);
    if (value) storeProviderToken(provider, value);
  }
}

// A new tmux server inherits the creating process's environment before Garden
// has a chance to hide provider keys. Blank every configured source variable
// on `new-session` itself so even the first pane starts clean; the real values
// remain in this CLI process long enough for syncAllProviderTokenVaults to copy
// them into hidden state immediately afterward.
export function providerSessionSanitizerArgs(config: GardenConfig): string[] {
  const names = new Set(
    Object.keys(config.providers ?? {}).map(name =>
      resolveProvider({ provider: name }, config)!.authTokenEnv,
    ),
  );
  return Array.from(names).flatMap(name => ["-e", `${name}=`]);
}

// Where the provider's key is available: the CLI process env (this shell) and
// the dashboard's hidden tmux vault. Ordinary panes never inherit the vault;
// `session: null` means no dashboard is running to ask.
export function providerTokenPresence(
  provider: ResolvedProvider,
): { shell: boolean; session: boolean | null } {
  const shell = Boolean(process.env[provider.authTokenEnv]);
  let session: boolean | null = null;
  if (dashboardExists()) {
    try {
      const vaultEnv = providerTokenVaultEnv(provider);
      const line = tmuxOutput(
        "show-environment", "-h", "-t", DASHBOARD_SESSION, vaultEnv,
      ).trim();
      session = line.startsWith(`${vaultEnv}=`)
        && line.length > vaultEnv.length + 1;
    } catch {
      session = false; // tmux exits non-zero for an unknown variable
    }
  }
  return { shell, session };
}

// Worker-pane launch chokepoint. Provider tokens stay hidden in tmux except
// for the single atomic command queue that creates or respawns this worker.
// Non-provider workers retain the ordinary tmux path byte-for-byte.
export function tmuxWorkerCommand(
  launchPlan: WorkerLaunchPlan,
  ...args: string[]
): void {
  const provider = launchPlan.resolvedProvider;
  if (!provider) {
    tmux(...args);
    return;
  }
  let available: boolean;
  if (process.env[provider.authTokenEnv]) {
    available = syncProviderTokenToVault(provider);
  } else {
    available = providerTokenPresence(provider).session === true
      || syncProviderTokenToVault(provider);
  }
  if (!available) {
    throw new Error(
      `Provider '${provider.name}' requires $${provider.authTokenEnv}; run Garden from a shell where it is set.`,
    );
  }
  tmuxWithHiddenEnvironment(providerTokenVaultEnv(provider), ...args);
}
