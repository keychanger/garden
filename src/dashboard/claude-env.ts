import {
  tryResolveClaudeProfile, tryResolveProvider, ENV_VAR_NAME_RE,
  type ProjectConfig, type GardenConfig, type ResolvedProvider,
} from "../config.js";
import { shellEscape, tmux, tmuxOutput } from "./tmux.js";
import { DASHBOARD_SESSION, dashboardExists } from "../session.js";
import { log } from "./log.js";

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

// Env prefix for a WORKER session: the project's provider env when one is
// configured, else the first-party claudeProfile env. Used by every worker
// launch/resume/bootstrap command builder in create.ts.
export function workerEnvPrefix(
  project: Pick<ProjectConfig, "claudeProfile" | "provider">,
  config?: GardenConfig,
): string {
  const provider = tryResolveProvider(project, config);
  if (provider) return providerEnvPrefix(provider);
  // A configured-but-unresolvable provider falls back to the first-party
  // path (matching the claudeProfile fallback idiom so launch paths never
  // abort wholesale) — but unlike a profile fallback this crosses a vendor
  // and spend boundary, so it must be loud, not silent.
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
// Anthropic-compatible endpoint. The auth token is referenced as
// `"$<name>"` — unexpanded in the generated command, expanded by the pane
// shell at spawn time — so the key value never appears in config.yml, tmux
// command lines, or ps output. The operator exports the named var in the
// shell that starts garden. ENV_VAR_NAME_RE is the injection guard for
// this deliberately unquoted interpolation; resolveProvider enforces it,
// and the recheck here keeps the guard local to the interpolation site.
export function providerEnvPrefix(provider: ResolvedProvider): string {
  if (!ENV_VAR_NAME_RE.test(provider.authTokenEnv)) {
    throw new Error(
      `Provider '${provider.name}': authTokenEnv '${provider.authTokenEnv}' is not a valid env var name.`,
    );
  }
  const parts = [
    `ANTHROPIC_BASE_URL=${shellEscape(provider.baseUrl)}`,
    `ANTHROPIC_AUTH_TOKEN="$${provider.authTokenEnv}"`,
  ];
  const map = provider.modelMap ?? {};
  if (map.opus) parts.push(`ANTHROPIC_DEFAULT_OPUS_MODEL=${shellEscape(map.opus)}`);
  if (map.sonnet) parts.push(`ANTHROPIC_DEFAULT_SONNET_MODEL=${shellEscape(map.sonnet)}`);
  if (map.haiku) parts.push(`ANTHROPIC_DEFAULT_HAIKU_MODEL=${shellEscape(map.haiku)}`);
  return parts.join(" ") + " ";
}

// The "$<name>" reference in providerEnvPrefix expands in the environment
// the tmux SERVER gives the pane — frozen at server start — not in the
// operator's current shell. Without an explicit bridge, a key exported
// after the dashboard started never reaches a worker, which would then hit
// the provider endpoint with an empty token. This pushes the key from the
// CLI process (which has the operator's shell env) into the dashboard's
// tmux session environment, where it persists for the server's lifetime
// and reaches every later respawn/bounce/loop launch. Called from the
// operator-shell entry points: provider add, config set, dashboard
// create/attach, and workers new.
export function syncProviderTokenToSession(provider: ResolvedProvider): void {
  const value = process.env[provider.authTokenEnv];
  if (!value) return;
  if (!dashboardExists()) return;
  try {
    tmux("set-environment", "-t", DASHBOARD_SESSION, provider.authTokenEnv, value);
  } catch (err) {
    log.warn("provider", "failed to sync provider token into tmux session env", {
      data: { provider: provider.name, envVar: provider.authTokenEnv, error: String(err) },
    });
  }
}

// Sync every provider referenced by a project. Called from dashboard
// create/attach — the moments the CLI provably runs with the operator's
// shell env and a tmux session exists to receive the values.
export function syncAllProviderTokens(config: GardenConfig): void {
  for (const project of Object.values(config.projects)) {
    const provider = tryResolveProvider(project, config);
    if (provider) syncProviderTokenToSession(provider);
  }
}

// Where the provider's key is actually visible: the CLI process env (this
// shell) and the dashboard's tmux session env (what worker panes inherit).
// `session: null` means no dashboard is running to ask.
export function providerTokenPresence(
  provider: ResolvedProvider,
): { shell: boolean; session: boolean | null } {
  const shell = Boolean(process.env[provider.authTokenEnv]);
  let session: boolean | null = null;
  if (dashboardExists()) {
    try {
      const line = tmuxOutput("show-environment", "-t", DASHBOARD_SESSION, provider.authTokenEnv).trim();
      session = line.startsWith(`${provider.authTokenEnv}=`)
        && line.length > provider.authTokenEnv.length + 1;
    } catch {
      session = false; // tmux exits non-zero for an unknown variable
    }
  }
  return { shell, session };
}
