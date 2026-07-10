// The Claude Code harness adapter — the default and reference
// implementation of HarnessAdapter. The light half (command dialect,
// prompt delivery, transient-error shapes, transcript reading) lives in
// claude-code-core.ts; this module adds the one heavyweight method —
// installRuntimeConfig, the .claude/settings.json + skills + excludes
// installer — and must only be imported by CLI-bundle modules (create,
// workers, loop). See harness/core.ts for the why.
//
// Module-init discipline: this file must never import create.ts,
// poller-*.ts, header.ts, or continue.ts — they (directly or transitively)
// import the harness registry, and a back-edge would re-open the
// init-cycle class that hook-dispatcher.ts was extracted to kill. Only
// leaf modules (tmux, sandbox, skills, runner, git, conversation,
// atomic-write, config, registry types) are safe imports.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ProjectConfig } from "../../config.js";
import { atomicWriteFile } from "../atomic-write.js";
import { getRemoteHost } from "../git.js";
import { resolveHookRunner, hookCompileCachePrefix } from "../runner.js";
import { buildSandboxConfig, type SandboxConfig } from "../sandbox.js";
import { installClaudeSkills } from "../skills.js";
import { claudeCodeCore } from "./claude-code-core.js";
import type { HarnessAdapter } from "./types.js";

export function buildSettingsJson(hookRunner: string, sandbox: SandboxConfig): string {
  // The hook commands are written into JSON and ultimately executed by Claude
  // Code as shell commands. The hook runner targets the minimal dist/hook.js
  // bundle (resolveHookRunner) so each per-tool-call fire parses only the
  // dispatcher's closure, not the whole CLI. Already pre-escaped per token, so
  // it interpolates safely without re-wrapping. The event name is appended by
  // each hook entry below; hook-entry.ts reads it from process.argv[2].
  //
  // Prefix a NODE_COMPILE_CACHE assignment so each cold-started hook process
  // reuses the cached V8 bytecode of the hook.js bundle (~8% faster cold start,
  // measured). Safe as a shell env-assignment prefix because Claude Code runs
  // these command strings through a shell — the existing multi-token
  // `<node> <hook.js> <event>` form already relies on that.
  const hookCmd = `${hookCompileCachePrefix()}${hookRunner}`;
  return JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} sessionstart`, timeout: 5 }],
      }],
      UserPromptSubmit: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} prompt`, timeout: 5 }],
      }],
      Stop: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} stop`, timeout: 5 }],
      }],
      PreToolUse: [{
        matcher: "AskUserQuestion",
        hooks: [{ type: "command", command: `${hookCmd} pretooluse`, timeout: 5 }],
      }, {
        matcher: "ExitPlanMode",
        hooks: [{ type: "command", command: `${hookCmd} pretooluse`, timeout: 5 }],
      }],
      PermissionRequest: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} pretooluse`, timeout: 5 }],
      }],
      PostToolUse: [{
        // Catch-all: auto-mode escalates any tool the classifier flags (Write,
        // Edit, Read, Bash, WebFetch, ...), not just Bash — so we need to see
        // every tool completion to clear "asking" after the operator approves.
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} posttooluse`, timeout: 5 }],
      }],
    },
    sandbox,
    permissions: {
      defaultMode: "auto",
      // Every subcommand of a compound bash call must match a rule, so tmux chains like `tmux ... | head` still prompt without tail-utility allowances.
      allow: [
        "Bash(tmux:*)",
        "Bash(echo:*)",
        "Bash(head:*)",
        "Bash(tail:*)",
        "Bash(cat:*)",
        "Bash(grep:*)",
        "Bash(wc:*)",
      ],
    },
  }, null, 2);
}

// Build the sandbox config for a Claude session rooted at targetDir. The
// worktree path becomes the writable root; the project's origin remote host
// is auto-added to the network allowlist; per-project sandboxDomains extend it.
function sandboxForTarget(targetDir: string, project: ProjectConfig): SandboxConfig {
  return buildSandboxConfig({
    worktreePath: targetDir,
    project,
    remoteHost: getRemoteHost(project.path),
  });
}

// Write to settings.json, not settings.local.json — Claude Code auto-edits the latter (permission approvals) and clobbers our hooks.
// Atomic write: Claude reads settings.json on SessionStart and on every --resume, so a partial file would break hook config silently.
// Mode 0o444 (read-only): defense-in-depth against an agent self-disabling
// its own sandbox. The worktree itself is writable by the worker (that's
// the point of the sandbox's allowWrite root), so a determined process can
// chmod the file before editing — but auto-mode's classifier escalates a
// chmod, and installRuntimeConfig is invoked on every refresh/bounce, so
// any tampering is rewritten on the next cycle. This makes the path of
// least resistance "ask the operator" rather than "edit the file."
function installRuntimeConfig(targetDir: string, project: ProjectConfig): void {
  const sandbox = sandboxForTarget(targetDir, project);
  const json = buildSettingsJson(resolveHookRunner(), sandbox);
  const settingsPath = path.join(targetDir, ".claude", "settings.json");
  // atomicWriteFile preserves the mode through tmp→rename. If the file
  // already exists with a different mode (operator chmod, agent
  // tampering), the rename replaces it with the read-only version.
  atomicWriteFile(settingsPath, json, { mode: 0o444 });
  installClaudeSkills(targetDir);
  ensureWorktreeExcludes(targetDir);
}

// Heal `.git/info/exclude` for existing worktrees. The bootstrap script
// writes these patterns at worker-spawn time (create.ts), but workers
// spawned before a new pattern was added need a refresh path.
// installRuntimeConfig runs on every dashboard refresh + bounce + post-merge
// auto-continue, so worktrees from earlier garden versions heal on their
// next cycle instead of carrying stale excludes forever.
//
// The exclude file lives at the git common dir (shared across worktrees);
// a missing entry is added once and persists.
function ensureWorktreeExcludes(targetDir: string): void {
  // The patterns must stay in sync with the bootstrap script's `for pattern`
  // loop in create.ts. .claude/ + .garden-hooks/ shipped with
  // the original worker; .garden/ was added when the grow workflow's goal +
  // log files needed to be hidden from git status; .garden-done is the
  // auto-continue suppression sentinel (so an accidental `git add -A` won't
  // start tracking it the way it did on wolf's main).
  const patterns = [".claude/", ".garden-hooks/", ".garden/", ".garden-done"];
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["-C", targetDir, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return; // Worktree may not exist yet on first hook installation.
  }
  // commonDir may be relative when targetDir is a worktree — resolve it
  // against targetDir so the join below points at the right info/exclude.
  const resolvedCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(targetDir, commonDir);
  const excludeFile = path.join(resolvedCommonDir, "info", "exclude");
  let current: string;
  try {
    current = fs.readFileSync(excludeFile, "utf-8");
  } catch {
    return; // No exclude file yet (rare; bootstrap will create one).
  }
  const lines = new Set(current.split("\n").map(l => l.trim()));
  const missing = patterns.filter(p => !lines.has(p));
  if (missing.length === 0) return;
  const tail = (current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n";
  try {
    fs.appendFileSync(excludeFile, tail);
  } catch {
    /* best effort — exclude is informational, not load-bearing */
  }
}

export const claudeCodeAdapter: HarnessAdapter = {
  ...claudeCodeCore,
  installRuntimeConfig,
};
