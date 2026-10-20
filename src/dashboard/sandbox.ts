import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  tryResolveProvider, resolveBeadsDir, resolveSandboxWriteRoots, type ProjectConfig,
} from "../config.js";
import { getGitCommonDir } from "./git.js";

export interface SandboxConfig {
  enabled: true;
  autoAllowBashIfSandboxed: true;
  filesystem: {
    allowWrite: string[];
    // Takes precedence over allowWrite. Globs are applied in full on macOS;
    // Claude Code warns that Linux support for them is partial.
    denyWrite?: string[];
    // OS-enforced read-deny for sandboxed subprocesses. Emitted only when the
    // project sets sandboxDenyCredentials (default off). See config.ts.
    denyRead?: string[];
  };
  network: {
    allowedDomains: string[];
    allowLocalBinding: boolean;
  };
  // Claude Code's purpose-built credential guard (mode "deny" is honored in a
  // repo's .claude/settings.json; "mask" is not, so it is never emitted here).
  credentials?: {
    files: { path: string; mode: "deny" }[];
  };
}

// Domains every garden-spawned Claude session needs. The Anthropic block
// stays unconditional even when the project's workers run on a provider:
// Claude reviewer/resolver/ci-fix settings use these same defaults
// and the first-party Anthropic path (see workerEnvPrefix /
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
// the JSON file. Workers already need this dir for seed files (handoff)
// — formalizing the allowance here keeps the convert
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

// The files in a linked worktree's admin entry (<common>/worktrees/<name>/)
// that tell git where its repository is and how it is configured.
const WORKTREE_ADMIN_FILES: readonly string[] = ["config.worktree", "commondir", "gitdir"];

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
  const slashTmp = fs.realpathSync("/tmp");
  const systemTmp = fs.realpathSync(os.tmpdir());
  allowWrite.add(slashTmp);
  allowWrite.add(systemTmp);

  // Bead-intake projects: workers run bd against the project's resolved
  // canonical .beads store (BEADS_DIR points there — the worktree copy has no
  // database; a configured beadsDir names a shared store instead), and every
  // bd invocation takes a write lock inside that dir.
  if (opts.project.beadIntake) {
    allowWrite.add(resolveBeadsDir(opts.project));
  }

  for (const root of resolveSandboxWriteRoots(opts.project)) allowWrite.add(root);

  const sandbox: SandboxConfig = {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: Array.from(allowWrite),
    },
    network: {
      allowedDomains: Array.from(domains),
      allowLocalBinding: opts.project.sandboxAllowLocalBinding === true,
    },
  };

  // The sandbox can write the shared git common dir (Claude Code grants it so
  // commits work), and with it every other worktree's admin entry. Claude Code
  // write-protects the session's own config and commondir but not a sibling's,
  // so a worker could point a sibling's commondir at a repository it controls,
  // or put an fsmonitor, ssh command or filter driver in the sibling's
  // config.worktree. Garden's own git in that worktree runs unsandboxed (the
  // poller's fetch, a hook's git status) and would run it. A glob, so worktrees
  // added after this session started are covered too.
  const commonDir = getGitCommonDir(opts.project.path);
  if (commonDir) {
    const root = realpathOr(commonDir);
    sandbox.filesystem.denyWrite = WORKTREE_ADMIN_FILES.map(file => path.join(root, "worktrees", "*", file));
  }

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

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
