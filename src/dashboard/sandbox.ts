import path from "node:path";
import { tryResolveProvider, type ProjectConfig } from "../config.js";

export interface SandboxConfig {
  enabled: true;
  autoAllowBashIfSandboxed: true;
  filesystem: {
    allowWrite: string[];
    // OS-enforced read-deny for sandboxed subprocesses. Emitted only when the
    // project sets sandboxDenyCredentials (default off). See config.ts.
    denyRead?: string[];
  };
  network: {
    allowedDomains: string[];
  };
  // Claude Code's purpose-built credential guard (mode "deny" is honored in a
  // repo's .claude/settings.json; "mask" is not, so it is never emitted here).
  credentials?: {
    files: { path: string; mode: "deny" }[];
  };
}

// Domains every garden-spawned Claude session needs. The Anthropic block
// stays unconditional even when the project's workers run on a provider:
// the reviewer/resolver/ci-fix agents share the worktree's settings.json
// and always run on the first-party Anthropic path (see workerEnvPrefix /
// claudeEnvPrefix in claude-env.ts). github/npm cover git pushes and
// installs during review checks. The git remote host and the provider's
// hosts are added separately at runtime.
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

// Operator credential paths a sandboxed subprocess is denied from reading when
// a project opts into sandboxDenyCredentials. Read-deny is OS-enforced and,
// per Claude Code's docs, applies to sandboxed Bash subprocesses only — the
// parent claude/reviewer authenticates before the sandbox boundary, so its own
// Anthropic auth is unaffected. Kept deliberately narrow: credential material,
// not general home-dir reads (which many build tools need).
const DENIED_CREDENTIAL_PATHS: readonly string[] = [
  "~/.claude",
  "~/.ssh",
  "~/.aws/credentials",
  "~/.config/gcloud",
  "~/.azure",
];

export function buildSandboxConfig(opts: {
  worktreePath: string;
  project: ProjectConfig;
  remoteHost: string | null;
}): SandboxConfig {
  const domains = new Set<string>(DEFAULT_DOMAINS);
  if (opts.remoteHost) domains.add(opts.remoteHost);
  for (const d of opts.project.sandboxDomains ?? []) domains.add(d);

  // Workers on a provider need its inference endpoint through the sandbox:
  // the baseUrl host automatically, plus any declared extras (e.g. Ollama
  // Cloud's routing host).
  const provider = tryResolveProvider(opts.project);
  if (provider) {
    try {
      // URL.hostname brackets IPv6 literals ("[::1]"); the allowlist uses
      // bare hostnames, so strip them.
      domains.add(new URL(provider.baseUrl).hostname.replace(/^\[|\]$/g, ""));
    } catch { /* validated at resolve; defensive */ }
    for (const d of provider.egressHosts ?? []) domains.add(d);
  }

  const allowWrite = new Set<string>(DEFAULT_ALLOW_WRITE);
  allowWrite.add(opts.worktreePath);

  // Bead-intake projects: workers run bd against the project checkout's
  // canonical .beads store (BEADS_DIR points there — the worktree copy has no
  // database), and every bd invocation takes a write lock inside that dir.
  if (opts.project.beadIntake) {
    allowWrite.add(path.join(opts.project.path, ".beads"));
  }

  const sandbox: SandboxConfig = {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: Array.from(allowWrite),
    },
    network: {
      allowedDomains: Array.from(domains),
    },
  };

  // Opt-in credential read-deny (default off; see ProjectConfig.sandboxDenyCredentials).
  // Emit both the purpose-built credentials guard and filesystem.denyRead so the
  // block holds across Claude Code versions.
  if (opts.project.sandboxDenyCredentials) {
    sandbox.filesystem.denyRead = [...DENIED_CREDENTIAL_PATHS];
    sandbox.credentials = {
      files: DENIED_CREDENTIAL_PATHS.map(path => ({ path, mode: "deny" as const })),
    };
  }

  return sandbox;
}
