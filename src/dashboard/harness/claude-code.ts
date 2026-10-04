// The Claude Code harness adapter — the default and reference
// implementation of HarnessAdapter. The light half (command dialect,
// prompt delivery, transient-error shapes, transcript reading) lives in
// claude-code-core.ts; this module adds the one heavyweight method —
// installRuntimeConfig, the garden settings file + skills + excludes
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
import { claudeSettingsPath } from "../headless-paths.js";
import { log } from "../log.js";
import { resolveHookRunner, hookCompileCachePrefix, resolveNodeBin } from "../runner.js";
import { buildSandboxConfig, type SandboxConfig } from "../sandbox.js";
import { shellEscape } from "../tmux.js";
import { installClaudeSkills } from "../skills.js";
import { claudeCodeCore } from "./claude-code-core.js";
import type { HarnessAdapter, RuntimeInstallOptions } from "./types.js";

// The status line: model, reasoning effort, and remaining context window,
// painted under the composer for the life of the session. Claude Code renders
// none of these persistently on its own — the model and effort are visible only
// right after a /model or /effort, and context usage only via /context — which
// leaves an operator scanning a fleet of worker panes unable to tell what a
// given worker is running on or how close it is to a compaction.
//
// Shipped as a file rather than an inline `node -e` because the command lands
// inside a JSON string that a shell then parses: a file keeps the script
// readable and the quoting to one shellEscape. Claude Code feeds it the session
// JSON on stdin (model.display_name, effort.level, context_window.*) and prints
// whatever the script writes to stdout.
export const STATUS_LINE_FILENAME = "statusline.mjs";

export const STATUS_LINE_SCRIPT = `// Written by garden (src/dashboard/harness/claude-code.ts). Edits are overwritten.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let s;
  try { s = JSON.parse(raw); } catch { return; }
  const parts = [];
  if (s.model && s.model.display_name) parts.push(s.model.display_name);
  if (s.effort && s.effort.level) parts.push(s.effort.level);
  const ctx = s.context_window || {};
  if (typeof ctx.remaining_percentage === "number") {
    const pct = Math.round(ctx.remaining_percentage);
    const size = ctx.context_window_size;
    parts.push(typeof size === "number" && size > 0
      ? pct + "% of " + Math.round(size / 1000) + "k context left"
      : pct + "% context left");
  }
  process.stdout.write(parts.join(" \u00b7 "));
});
`;

// The settings.json `statusLine.command`, executed by Claude Code through a
// shell. Node is resolved the same way every other baked garden command
// resolves it (a stable PATH symlink, never a versioned Cellar path).
export function statusLineCommand(targetDir: string): string {
  const script = path.join(targetDir, ".claude", STATUS_LINE_FILENAME);
  return `${shellEscape(resolveNodeBin())} ${shellEscape(script)}`;
}

export function buildSettingsJson(
  hookRunner: string,
  sandbox: SandboxConfig,
  statusLineCmd: string,
  opts: { ultracode?: boolean } = {},
): string {
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
    statusLine: { type: "command", command: statusLineCmd },
    // The non-effort half of the ultracode preset (the dynamic-workflow
    // keyword trigger); the launch command adds `--effort max`.
    ...(opts.ultracode ? { ultracodeKeywordTrigger: "on" } : {}),
    permissions: {
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

export function installHeadlessSettings(targetDir: string, project: ProjectConfig, settingsFile: string): void {
  const json = buildSettingsJson(resolveHookRunner(), sandboxForTarget(targetDir, project), statusLineCommand(targetDir));
  atomicWriteFile(settingsFile, json, { mode: 0o444 });
}

// Garden's settings live outside the worktree and reach Claude through
// `--settings` (see claudeSettingsPath), not in .claude/settings.json: a repo
// that commits its own settings file would otherwise see it overwritten, show
// it as modified, and never pass the clean-tree review gate. Claude Code merges
// the two, so the repo's permissions, env, and hooks also keep applying.
// Atomic write: Claude reads the file on SessionStart and on every --resume,
// so a partial file would break hook config silently. Mode 0o444 and a
// directory outside every worker sandbox: the agent cannot edit its own
// sandbox, and installRuntimeConfig rewrites the file on every refresh/bounce.
function installRuntimeConfig(targetDir: string, project: ProjectConfig, runtime?: RuntimeInstallOptions): void {
  const sandbox = sandboxForTarget(targetDir, project);
  const json = buildSettingsJson(resolveHookRunner(), sandbox, statusLineCommand(targetDir), {
    ultracode: runtime?.ultracode,
  });
  atomicWriteFile(claudeSettingsPath(targetDir), json, { mode: 0o444 });
  // 0o555 for the same reason the settings file is 0o444: the status line is a
  // command garden bakes into those settings, so the script it points at is part
  // of the same trust boundary and is rewritten on every refresh/bounce.
  atomicWriteFile(path.join(targetDir, ".claude", STATUS_LINE_FILENAME), STATUS_LINE_SCRIPT, { mode: 0o555 });
  installClaudeSkills(targetDir);
  ensureWorktreeExcludes(targetDir);
  if (runtime?.beforeLaunch) retireWorktreeSettings(targetDir);
}

// Earlier builds wrote garden's settings into <dir>/.claude/settings.json.
// Launched with `--settings`, Claude would load that copy as project settings
// too and fire every hook twice, so the copy goes before the launch: deleted
// when untracked, or restored from git when garden overwrote a tracked file.
// Recognized by garden's own SessionStart hook command, so a settings file
// the operator wrote is never touched.
// A failure here only costs duplicate hook events, so it is logged rather than
// allowed to block the launch.
function retireWorktreeSettings(targetDir: string): void {
  const rel = path.join(".claude", "settings.json");
  const file = path.join(targetDir, rel);
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }
  if (!isGardenSettings(content)) return;
  try {
    if (!isTracked(targetDir, rel)) {
      fs.rmSync(file, { force: true });
      return;
    }
    // A worker may have hidden the overwritten file with skip-worktree, the
    // workaround before this fix; checkout skips such a path, so clear it first.
    execFileSync("git", ["-C", targetDir, "update-index", "--no-skip-worktree", "--", rel], { stdio: "pipe" });
    execFileSync("git", ["-C", targetDir, "checkout", "--", rel], { stdio: "pipe" });
  } catch (err) {
    log.warn("workers", "old garden settings.json not retired; hooks may double", {
      data: { dir: targetDir, error: String(err) },
    });
  }
}

function isTracked(dir: string, rel: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", rel], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GARDEN_SESSIONSTART_HOOK = /(?:hook\.js|hook-entry\.ts|_claude-hook)'? sessionstart$/;

function isGardenSettings(content: string): boolean {
  try {
    const settings = JSON.parse(content) as { hooks?: { SessionStart?: { hooks?: { command?: unknown }[] }[] } };
    return (settings.hooks?.SessionStart ?? []).some(group =>
      (group.hooks ?? []).some(hook => typeof hook.command === "string" && GARDEN_SESSIONSTART_HOOK.test(hook.command)));
  } catch {
    return false;
  }
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
  const patterns = [".claude/", ".garden-hooks/", ".garden/", ".garden-done", ".garden-awaiting-input"];
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
