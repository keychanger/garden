import type { ProjectConfig } from "../config.js";

export interface SandboxConfig {
  enabled: true;
  autoAllowBashIfSandboxed: true;
  filesystem: {
    allowWrite: string[];
  };
  network: {
    allowedDomains: string[];
  };
}

// Domains every garden-spawned Claude session needs. Workers and reviewers
// must reach Anthropic (inference, telemetry) and npm (installs during
// review checks). The git remote host is added separately at runtime.
const DEFAULT_DOMAINS: readonly string[] = [
  "api.anthropic.com",
  "*.anthropic.com",
  "statsig.anthropic.com",
  "sentry.io",
  "*.sentry.io",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "*.npmjs.org",
];

// Subprocess write paths outside the worktree (CWD is writable by default).
// npm and friends need their caches; /tmp is needed by many build tools.
const DEFAULT_ALLOW_WRITE: readonly string[] = [
  "~/.npm",
  "~/.cache",
  "/tmp",
];

export function buildSandboxConfig(opts: {
  worktreePath: string;
  project: ProjectConfig;
  remoteHost: string | null;
}): SandboxConfig {
  const domains = new Set<string>(DEFAULT_DOMAINS);
  if (opts.remoteHost) domains.add(opts.remoteHost);
  for (const d of opts.project.sandboxDomains ?? []) domains.add(d);

  const allowWrite = new Set<string>(DEFAULT_ALLOW_WRITE);
  allowWrite.add(opts.worktreePath);

  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: Array.from(allowWrite),
    },
    network: {
      allowedDomains: Array.from(domains),
    },
  };
}
