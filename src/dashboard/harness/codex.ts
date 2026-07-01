// The Codex harness adapter — the heavy half. The light dialect
// (commands, transient-error, transcript, session identity) lives in
// codex-core.ts; this module adds installRuntimeConfig — the
// .codex/hooks.json event-relay installer — and must only be imported by
// CLI-bundle modules. Same core/full split rationale as claude-code.ts (see
// harness/core.ts): keeps the hook bundle lean.
//
// Module-init discipline: never import create.ts, poller-*.ts, header.ts,
// or continue.ts — a back-edge would re-open the init-cycle class
// hook-dispatcher.ts was extracted to kill. Only leaf modules are safe.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ProjectConfig } from "../../config.js";
import { atomicWriteFile } from "../atomic-write.js";
import { resolveHookRunner } from "../runner.js";
import { codexCore } from "./codex-core.js";
import type { HarnessAdapter } from "./types.js";

// The .codex/hooks.json content: garden's normalized lifecycle relay, reusing
// the SAME hook runner (dist/hook.js) and the SAME garden wire event names as
// argv that claude-code's settings.json uses (hook-dispatcher.ts switches on
// them; readHookInput reads Codex's stdin-JSON payload, which carries
// transcript_path/session_id/cwd exactly like Claude's). The one divergence
// from claude-code's mapping: Codex's PreToolUse fires for EVERY tool (not a
// matcher-gated approval prompt), so it maps to `posttooluse` (a working
// heartbeat), while `PermissionRequest` is the real blocked-on-operator
// (`pretooluse` -> asking) signal. Trust: garden writes this file
// programmatically, so Codex treats it as untrusted and skips it unless the
// worker launch passes --dangerously-bypass-hook-trust (codex-core's
// buildAgentCommand does; the headless reviewer deliberately does not).
// The precise per-turn Stop firing is verified in the worker-path slice.
export function buildCodexHooksJson(hookRunner: string): string {
  const entry = (event: string) => [{
    hooks: [{ type: "command", command: `${hookRunner} ${event}`, timeout: 5 }],
  }];
  return JSON.stringify({
    hooks: {
      SessionStart: entry("sessionstart"),
      UserPromptSubmit: entry("prompt"),
      Stop: entry("stop"),
      PostToolUse: entry("posttooluse"),
      PreToolUse: entry("posttooluse"),
      PermissionRequest: entry("pretooluse"),
    },
  }, null, 2);
}

// Write the Codex runtime config into the worktree. For Slice A this is the
// event-relay hooks.json plus the git-exclude for .codex/ — enough for a
// Codex WORKER's status to reach the poller and for a Codex REVIEWER (which
// skips the hooks) to run cleanly. AGENTS.md rules delivery, sandbox/network
// translation, and the union-excludes generalization land in later slices.
function installRuntimeConfig(targetDir: string, _project: ProjectConfig): void {
  const hooksPath = path.join(targetDir, ".codex", "hooks.json");
  atomicWriteFile(hooksPath, buildCodexHooksJson(resolveHookRunner()));
  ensureWorktreeExcludes(targetDir);
}

// Add .codex/ (plus the garden-generic patterns) to the shared git-common-dir
// info/exclude. Accumulates alongside any .claude/ a claude worker added, so a
// cross-harness worktree ends up excluding both — the full union is formalized
// in the headless-config slice. Mirrors claude-code.ts's ensureWorktreeExcludes.
function ensureWorktreeExcludes(targetDir: string): void {
  const patterns = [".codex/", ".garden-hooks/", ".garden/", ".garden-done"];
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
