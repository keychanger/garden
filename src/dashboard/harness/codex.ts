// The Codex harness adapter — the heavy half. The light dialect
// (commands, transient-error, transcript, session identity) lives in
// codex-core.ts; this module adds installRuntimeConfig — the worktree
// runtime installer (directory-trust seed in CODEX_HOME/config.toml +
// git-excludes; the composed rules ride the worktree AGENTS.override.md via
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
import type { ProjectConfig } from "../../config.js";
import { atomicWriteFile } from "../atomic-write.js";
import { withFileLock } from "../file-lock.js";
import { runGit, runGitBytes } from "../git-exec.js";
import { log } from "../log.js";
import { appendToStableFile, readStableRegularFile, rewriteStableFile } from "../safe-read.js";
import { AGENTS_MARKER, composeAgentsMd, composedOver, stripGardenRules } from "./agents-md.js";
import { codexCore } from "./codex-core.js";
import type { HarnessAdapter } from "./types.js";

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
}

// Write the Codex runtime config into the worktree/CODEX_HOME. Idempotent;
// called at bootstrap (via the _install-worker-runtime subcommand), refresh,
// bounce, and loop respawn. Installs the git-excludes and the per-repo
// directory-trust entry so an autonomous Codex worker does not halt on the
// interactive "trust this directory?" prompt. The lifecycle hook relay is NOT
// a file here — it is injected into the launch command as `-c` overrides
// (codex-core codexHookFlags), because Codex does not load hooks from a linked
// worktree's .codex/hooks.json (it resolves project hooks at the repo root).
// Rules delivery (AGENTS.override.md, loaded from the worktree cwd) is separate
// — it needs the composed rules text and rides installCodexAgentsMd at spawn.
function installRuntimeConfig(
  targetDir: string,
  _project: ProjectConfig,
  runtime?: { rulesText?: string },
): void {
  ensureWorktreeExcludes(targetDir);
  ensureDirectoryTrust(targetDir);
  if (runtime?.rulesText !== undefined) {
    installCodexAgentsMd(targetDir, runtime.rulesText);
  }
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
// worktree of the project. Garden's read/check/append is serialized across
// worker bootstraps so two simultaneous Codex launches cannot emit duplicate
// TOML tables.
function ensureDirectoryTrust(targetDir: string): void {
  const repoRoot = resolveRepoRoot(targetDir);
  if (!repoRoot) return;
  const cfg = path.join(codexHome(), "config.toml");
  const header = `[projects.${JSON.stringify(repoRoot)}]`;
  try {
    withFileLock(`${cfg}.garden.lock`, () => {
      let current = "";
      try {
        current = fs.readFileSync(cfg, "utf-8");
      } catch {
        /* file may not exist yet — created by the append below */
      }
      if (current.includes(header)) return;
      const sep = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      fs.appendFileSync(cfg, `${sep}${header}\ntrust_level = "trusted"\n`);
    }, { name: "codex-trust" });
  } catch {
    /* best effort — a missed trust entry surfaces as the interactive prompt */
  }
}

// The repository root Codex resolves for a (possibly linked) worktree: the
// parent of the git common dir. For a standard checkout that is the checkout
// itself; for a linked worktree it is the main checkout. Null if not a repo.
function resolveRepoRoot(targetDir: string): string | null {
  try {
    const commonDir = runGit(targetDir, ["rev-parse", "--git-common-dir"]).trim();
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
// system-prompt flag, so its instructions come from the project instruction
// files it reads at session start. Codex reads at most one per directory and
// prefers AGENTS.override.md to AGENTS.md (verified against 0.163.0), so garden
// writes its rules, with the repo's own AGENTS.md below them, to the worktree's
// AGENTS.override.md and never touches AGENTS.md. That file stays an ordinary
// tracked file: a rebase, reset or merge can update it, and a worker's edit to
// it shows in `git status` and commits. The override is untracked and excluded
// by a root-anchored pattern (ensureWorktreeExcludes), so it reaches neither a
// commit nor the clean-tree review gate. rulesText is the same composed rules a
// Claude worker gets via --append-system-prompt-file.
// Read unsandboxed, then delivered back to the worker as its instructions: a
// symlink planted at either file would otherwise hand the worker a file its own
// sandbox cannot read. A file that is not plain counts as missing, and the
// write below replaces it rather than following it.
const MAX_AGENTS_MD_BYTES = 4 * 1024 * 1024;
const AGENTS_OVERRIDE = "AGENTS.override.md";

// The worker is not this file's only reader: a reviewer, resolver or CI-fix run
// that Codex runs in the worktree loads it as project instructions too. Claude
// reviewers that read the worker rules unscoped (through a repo's CLAUDE.md
// `@AGENTS.md` import, when garden wrote them there) pushed their review
// commits "so the poller sees" them, and asked to rerun the push outside the
// sandbox when it refused.
const HEADLESS_SCOPE_NOTE = "These are garden's instructions for the worker session that owns this "
  + "worktree. If garden launched you headless to review, resolve or CI-fix this branch, they are "
  + "not yours: follow your prompt, push only if it tells you to, and leave `.garden-done`, "
  + "`.garden-awaiting-input` and `garden blocked` to the worker.";

export function installCodexAgentsMd(targetDir: string, rulesText: string): void {
  retireAgentsMdComposition(targetDir);
  const existing = readWorktreeFile(targetDir, AGENTS_OVERRIDE);
  // An override garden did not write belongs to the repo or the operator, and
  // Codex reads it in place of garden's rules, as it did when garden wrote
  // AGENTS.md. A tracked one is never written either.
  if ((existing !== null && !existing.startsWith(AGENTS_MARKER)) || isTracked(targetDir, AGENTS_OVERRIDE)) {
    log.warn("workers", "AGENTS.override.md is not garden's; left as is", { data: { dir: targetDir } });
    return;
  }
  // Stripped: AGENTS.md still holds an older composition when its retirement failed.
  const original = stripGardenRules(readWorktreeFile(targetDir, "AGENTS.md") ?? "");
  const next = composeAgentsMd(`${HEADLESS_SCOPE_NOTE}\n\n${rulesText}`, original);
  if (next !== existing) atomicWriteFile(path.join(targetDir, AGENTS_OVERRIDE), next);
}

// Older builds composed the rules into AGENTS.md itself, behind skip-worktree
// when the repo tracks it. Git then refuses to rebase, reset or merge across a
// base change to AGENTS.md, and a worker's edit to it can be neither seen nor
// committed, so the composition is retired: a tracked file restored from the
// index and unhidden, an untracked one deleted. Recognized by AGENTS_MARKER, so
// a file garden did not write is never touched. Anything in it besides garden's
// rules and the repo's text (a worker's edit) is saved beside it first, as an
// excluded AGENTS.md.garden-legacy-<ms>, and a failure leaves the file alone.
// The index blob is written directly rather than checked out, so no filter a
// worker configured runs in this unsandboxed process.
function retireAgentsMdComposition(targetDir: string): void {
  const agentsPath = path.join(targetDir, "AGENTS.md");
  const current = readWorktreeFile(targetDir, "AGENTS.md");
  if (current === null || !current.startsWith(AGENTS_MARKER)) return;
  try {
    const indexed = isTracked(targetDir, "AGENTS.md")
      ? runGitBytes(targetDir, ["cat-file", "blob", ":AGENTS.md"], "")
      : null;
    const onlyGardens = indexed
      ? composedOver(current, indexed.toString("utf-8"))
      : !stripGardenRules(current).trim();
    if (!onlyGardens) {
      const saved = path.join(targetDir, `AGENTS.md.garden-legacy-${Date.now()}`);
      atomicWriteFile(saved, current);
      log.warn("workers", "saved AGENTS.md edits aside before retiring it", { data: { saved } });
    }
    if (indexed) {
      atomicWriteFile(agentsPath, indexed);
      runGit(targetDir, ["update-index", "--no-skip-worktree", "--", "AGENTS.md"]);
    } else {
      fs.rmSync(agentsPath, { force: true });
    }
  } catch (err) {
    log.warn("workers", "garden's AGENTS.md composition not retired", {
      data: { dir: targetDir, error: String(err) },
    });
  }
}

function readWorktreeFile(targetDir: string, name: string): string | null {
  return readStableRegularFile(path.join(targetDir, name), targetDir, MAX_AGENTS_MD_BYTES)?.data.toString("utf-8") ?? null;
}

function isTracked(targetDir: string, relPath: string): boolean {
  try {
    runGit(targetDir, ["ls-files", "--error-unmatch", relPath], { quietStderr: true });
    return true;
  } catch {
    return false;
  }
}

// Add Codex's root files (plus the garden-generic patterns) to the shared
// git-common-dir info/exclude. Accumulates alongside any .claude/ a claude
// worker added, so a cross-harness worktree ends up excluding both — the full
// union is formalized in the headless-config slice. Mirrors claude-code.ts's
// ensureWorktreeExcludes, whose patterns, like the bootstrap's (create.ts),
// match at every depth; these are Codex's alone, so anchored here.
const MAX_EXCLUDE_BYTES = 1024 * 1024;

// The file governs the operator's checkout and every worktree of the project,
// and a pattern without a slash matches at any depth: the bare `AGENTS.md` line
// older builds wrote hid every new nested AGENTS.md from `git add -A`
// repo-wide, as `.codex/` did every nested .codex/. So these are root-anchored,
// and those two lines go.
const CODEX_EXCLUDES = ["/.codex/", `/${AGENTS_OVERRIDE}`, "/AGENTS.md.garden-legacy-*"];
const UNANCHORED_CODEX_EXCLUDES = new Set(["AGENTS.md", ".codex/"]);

function ensureWorktreeExcludes(targetDir: string): void {
  const patterns = [".garden-hooks/", ".garden/", ".garden-done", ".garden-awaiting-input", ...CODEX_EXCLUDES];
  let commonDir: string;
  try {
    commonDir = runGit(targetDir, ["rev-parse", "--git-common-dir"]).trim();
  } catch {
    return;
  }
  const resolvedCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(targetDir, commonDir);
  const excludeFile = path.join(resolvedCommonDir, "info", "exclude");
  // The shared git dir is worker-writable, and this runs unsandboxed: a
  // symlink or FIFO planted at info/exclude must be neither followed nor
  // written through.
  const read = () => readStableRegularFile(excludeFile, resolvedCommonDir, MAX_EXCLUDE_BYTES);
  let file = read();
  if (!file) return; // No exclude file yet (rare; bootstrap will create one), or not a plain file.
  let current = file.data.toString("utf-8");
  const present = new Set(current.split("\n").map(l => l.trim()));
  const missing = patterns.filter(p => !present.has(p));
  try {
    if (missing.length > 0) {
      appendToStableFile(excludeFile, file, (current === "" || current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n");
    }
    if (![...UNANCHORED_CODEX_EXCLUDES].some(p => present.has(p))) return;
    // In a checkout where an older build's untracked composition is still in
    // AGENTS.md, the bare line is all that keeps it out of `git status` and a
    // commit. So every checkout's is retired first, and the line stays while
    // one remains.
    const keepAgentsLine = present.has("AGENTS.md") && !retireEveryCheckout(targetDir);
    file = read();
    if (!file) return;
    current = file.data.toString("utf-8");
    const lines = current.split("\n");
    const kept = lines.filter(l => {
      const p = l.trim();
      return !UNANCHORED_CODEX_EXCLUDES.has(p) || (keepAgentsLine && p === "AGENTS.md");
    });
    if (kept.length < lines.length) rewriteStableFile(excludeFile, file, kept.join("\n"));
  } catch {
    /* best effort */
  }
}

// Retire an older build's AGENTS.md composition in every checkout of the repo;
// true when none is left untracked.
function retireEveryCheckout(targetDir: string): boolean {
  let listing: string;
  try {
    listing = runGit(targetDir, ["worktree", "list", "--porcelain"]);
  } catch {
    return false;
  }
  let clear = true;
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length);
    retireAgentsMdComposition(dir);
    if (readWorktreeFile(dir, "AGENTS.md")?.startsWith(AGENTS_MARKER) && !isTracked(dir, "AGENTS.md")) clear = false;
  }
  return clear;
}

export const codexAdapter: HarnessAdapter = {
  ...codexCore,
  installRuntimeConfig,
};
