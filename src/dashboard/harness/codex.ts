// The Codex harness adapter — the heavy half. The light dialect
// (commands, transient-error, transcript, session identity) lives in
// codex-core.ts; this module adds installRuntimeConfig — the worktree
// runtime installer (directory-trust seed in CODEX_HOME/config.toml +
// git-excludes; the composed rules ride the worktree AGENTS.md via
// installCodexAgentsMd). The lifecycle event relay is NOT installed here —
// it is injected as `-c` launch overrides by codex-core's codexHookFlags
// (a worktree .codex/hooks.json never fires — Codex resolves project hooks
// at the repo root). Must only be imported by CLI-bundle modules. Same
// core/full split rationale as claude-code.ts (see harness/core.ts): keeps
// the hook bundle lean.
//
// Module-init discipline: never import create.ts, poller-*.ts, header.ts,
// or continue.ts — a back-edge would re-open the init-cycle class
// hook-dispatcher.ts was extracted to kill. Only leaf modules are safe.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ProjectConfig } from "../../config.js";
import { atomicWriteFile } from "../atomic-write.js";
import { codexCore } from "./codex-core.js";
import type { HarnessAdapter } from "./types.js";

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
}

// Marker prefixing garden's rules inside a worktree AGENTS.md, so a re-install
// is idempotent and a composed file is recognizable.
const AGENTS_MARKER = "<!-- garden worker rules (managed by garden; not committed) -->";

// Write the Codex runtime config into the worktree/CODEX_HOME. Idempotent;
// called at bootstrap (via the _install-worker-runtime subcommand), refresh,
// bounce, and loop respawn. Installs the git-excludes and the per-repo
// directory-trust entry so an autonomous Codex worker does not halt on the
// interactive "trust this directory?" prompt. The lifecycle hook relay is NOT
// a file here — it is injected into the launch command as `-c` overrides
// (codex-core codexHookFlags), because Codex does not load hooks from a linked
// worktree's .codex/hooks.json (it resolves project hooks at the repo root).
// Rules delivery (AGENTS.md, loaded from the worktree cwd) is separate — it
// needs the composed rules text and rides installCodexAgentsMd at spawn.
function installRuntimeConfig(targetDir: string, _project: ProjectConfig): void {
  ensureWorktreeExcludes(targetDir);
  ensureDirectoryTrust(targetDir);
}

// Pre-seed the worktree's repository as a trusted project in
// CODEX_HOME/config.toml. The interactive Codex TUI halts on a "Do you trust
// the contents of this directory?" prompt on first entry into an untrusted
// repo — a separate gate from --dangerously-bypass-hook-trust (which only
// covers hooks). An autonomous worker cannot answer it, so garden writes the
// same `[projects."<dir>"] trust_level = "trusted"` block Codex persists on
// "Yes".
//
// Load-bearing (verified 2026-07-06): Codex scopes trust to the REPOSITORY
// ROOT, and for a linked git worktree that root is the MAIN checkout — the git
// common dir's parent — NOT the worktree itself. Seeding the worktree path
// leaves Codex still prompting ("Trusting will apply to the repository root:
// <main>"). So garden seeds the repo root; one entry then covers every
// worktree of the project. Idempotent; appended (garden seeds before launching
// Codex, so there is no concurrent writer to clobber).
function ensureDirectoryTrust(targetDir: string): void {
  const repoRoot = resolveRepoRoot(targetDir);
  if (!repoRoot) return;
  const cfg = path.join(codexHome(), "config.toml");
  const header = `[projects.${JSON.stringify(repoRoot)}]`;
  let current = "";
  try {
    current = fs.readFileSync(cfg, "utf-8");
  } catch {
    /* file may not exist yet — created by the append below */
  }
  if (current.includes(header)) return;
  const sep = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  try {
    fs.mkdirSync(codexHome(), { recursive: true });
    fs.appendFileSync(cfg, `${sep}${header}\ntrust_level = "trusted"\n`);
  } catch {
    /* best effort — a missed trust entry surfaces as the interactive prompt */
  }
}

// The repository root Codex resolves for a (possibly linked) worktree: the
// parent of the git common dir. For a standard checkout that is the checkout
// itself; for a linked worktree it is the main checkout. Null if not a repo.
function resolveRepoRoot(targetDir: string): string | null {
  try {
    const commonDir = execFileSync("git", ["-C", targetDir, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
    }).trim();
    const abs = path.isAbsolute(commonDir) ? commonDir : path.resolve(targetDir, commonDir);
    const root = path.dirname(abs);
    // Codex resolves symlinks before matching the trust entry (macOS /var ->
    // /private/var, etc.), so seed the realpath or the entry silently misses.
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  } catch {
    return null;
  }
}

// Deliver garden's composed worker rules to a Codex worker. Codex has no
// system-prompt flag — its only instruction channel is AGENTS.md (verified
// against 0.142.5: no instructions-file config key exists) — so garden owns
// the worktree AGENTS.md. If the repo ships its own, garden's rules are
// prepended above a delimiter, the original preserved, and the file marked
// skip-worktree so `git status` stays clean and it is never committed. If not,
// garden writes it fresh (excluded via ensureWorktreeExcludes). Idempotent on
// the marker. rulesText is the same composed rules a Claude worker gets via
// --append-system-prompt-file.
export function installCodexAgentsMd(targetDir: string, rulesText: string): void {
  const agentsPath = path.join(targetDir, "AGENTS.md");
  const body = `${AGENTS_MARKER}\n\n${rulesText.trim()}\n`;
  const tracked = isTracked(targetDir, "AGENTS.md");
  if (tracked) {
    let original = "";
    try {
      original = fs.readFileSync(agentsPath, "utf-8");
    } catch {
      /* tracked but missing in the worktree — treat as empty original */
    }
    if (original.startsWith(AGENTS_MARKER)) return;
    atomicWriteFile(agentsPath, `${body}\n---\n\n${original.trimStart()}`);
    // Keep the local composition out of `git status` / commits.
    try {
      execFileSync("git", ["-C", targetDir, "update-index", "--skip-worktree", "AGENTS.md"]);
    } catch {
      /* best effort */
    }
  } else {
    atomicWriteFile(agentsPath, body);
    // Untracked garden file — exclude it (ensureWorktreeExcludes carries the
    // AGENTS.md pattern) so it never appears in the worker's git status.
  }
}

function isTracked(targetDir: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", targetDir, "ls-files", "--error-unmatch", relPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// Add .codex/ (plus the garden-generic patterns) to the shared git-common-dir
// info/exclude. Accumulates alongside any .claude/ a claude worker added, so a
// cross-harness worktree ends up excluding both — the full union is formalized
// in the headless-config slice. Mirrors claude-code.ts's ensureWorktreeExcludes.
function ensureWorktreeExcludes(targetDir: string): void {
  // AGENTS.md: garden writes the worker rules here for Codex (installCodexAgentsMd).
  // Excluded so the untracked garden file never shows in the worker's git
  // status; harmless when the repo tracks its own AGENTS.md (info/exclude never
  // ignores a tracked path — that case is handled via skip-worktree instead).
  const patterns = [".codex/", ".garden-hooks/", ".garden/", ".garden-done", "AGENTS.md"];
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["-C", targetDir, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return;
  }
  const resolvedCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(targetDir, commonDir);
  const excludeFile = path.join(resolvedCommonDir, "info", "exclude");
  let current: string;
  try {
    current = fs.readFileSync(excludeFile, "utf-8");
  } catch {
    return;
  }
  const lines = new Set(current.split("\n").map(l => l.trim()));
  const missing = patterns.filter(p => !lines.has(p));
  if (missing.length === 0) return;
  const tail = (current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n";
  try {
    fs.appendFileSync(excludeFile, tail);
  } catch {
    /* best effort */
  }
}

export const codexAdapter: HarnessAdapter = {
  ...codexCore,
  installRuntimeConfig,
};
