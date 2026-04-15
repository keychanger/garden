// Resolves the CLAUDE_CONFIG_DIR env var for a given project. Returns "" for
// projects on the default profile so launch sites can unconditionally prepend
// the result to their claude shell commands.
import { tryResolveClaudeProfile, type ProjectConfig, type GardenConfig } from "../config.js";
import { shellEscape } from "./tmux.js";

export function claudeConfigDirFor(
  project: Pick<ProjectConfig, "claudeProfile">,
  config?: GardenConfig,
): string | null {
  const profile = tryResolveClaudeProfile(project, config);
  return profile?.configDir ?? null;
}

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
