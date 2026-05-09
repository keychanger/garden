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
// `~/.garden/sessions` covers garden CLI subcommands that mutate the
// registry from inside a worker pane — `garden workers grow` (the convert
// path's primary DX, invoked by the `/grow` slash skill) and any future
// self-mutating subcommands. The registry's withFileLock + atomicWriteFile
// pattern means writes go through `<file>.lock` and `<file>.tmp.<pid>`
// staging files, so the entire directory needs to be writable, not just
// the JSON file. Workers already need this dir for seed files (handoff,
// trellis vine plant) — formalizing the allowance here keeps the convert
// flow ergonomic without one-off sandbox bypasses per invocation.
const DEFAULT_ALLOW_WRITE: readonly string[] = [
  "~/.npm",
  "~/.cache",
  "~/.garden/sessions",
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
