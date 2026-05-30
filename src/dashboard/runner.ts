// Resolve the absolute command line to invoke garden's CLI from a child
// process. Used by every code path that spawns a detached subprocess (Claude
// Code hooks, post-merge auto-continue, the worker pre-push hook, etc.). Lives
// in its own leaf module so it can be imported from anywhere — including
// hooks/default.ts — without dragging the rest of dashboard/create.ts into
// the import graph. This severed the module-init cycle through create.ts
// (workflows/default.ts -> hooks/default.ts -> create.ts -> poller.ts ->
// workflows/index.ts -> workflows/default.ts). The companion break — moving
// handleClaudeHook out of header.ts into hook-dispatcher.ts so header.ts
// itself no longer imports workflows/index.ts — closes the second path.
// With both severed, defaultWorkflow.hookHandlers can hold a captured value.
//
// The returned string is a multi-token shell command line: an interpreter
// path followed by a script path, separated by a space. Each token is
// individually shell-escaped so the joined string interpolates safely into
// any shell context — but call sites must NOT re-wrap it in shellEscape,
// which would single-quote the whole thing and turn it into a non-existent
// filename containing a literal space.
import fs from "node:fs";
import path from "node:path";
import { shellEscape } from "./tmux.js";

// Worktree paths are ephemeral — once a worker's branch merges and its
// worktree is cleaned up, every persisted reference (tmux key bindings,
// .claude/settings.json hook commands, hidden window long-running shells)
// that baked the path becomes a dead pointer with MODULE_NOT_FOUND on
// every fire. resolveGardenRunner is called from the dashboard process to
// build the command string those persistence sites bake. The dashboard is
// often launched out of a worker worktree during dev (a common agent
// pattern: `node <worktree>/dist/cli.js dashboard ...` to test changes
// without rebuilding the npm-linked global). Without this guard, that
// invocation poisons every persistence site, and the poison reproduces
// itself: any subprocess spawned via a poisoned tmux binding or hidden
// window inherits the same argv[1], so the next worker created via
// `⌥n` writes the worktree path into ITS settings.json too — chaining
// the failure to fresh workers that never touched the original worktree.
const WORKTREE_MARKER = "/.garden/worktrees/";

export function resolveGardenRunner(): string {
  const direct = path.resolve(process.argv[1]);

  // tsx/dev path — argv[1] points at a .ts source file, not a built dist.
  // Keep using it directly: dev mode is short-lived and the operator
  // explicitly chose tsx; the worktree-stability concern below doesn't apply.
  if (direct.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(direct));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    return fs.existsSync(tsxBin)
      ? `${shellEscape(tsxBin)} ${shellEscape(direct)}`
      : `npx tsx ${shellEscape(direct)}`;
  }

  // Built dist/cli.js path. If argv[1] sits inside a worker worktree,
  // prefer the stable global install (npm-linked at /opt/homebrew/bin or
  // similar) so the path we persist survives the worktree's eventual
  // cleanup. Falls back to argv[1] when no stable global is on PATH —
  // operators without `npm link` get the old behavior.
  if (direct.includes(WORKTREE_MARKER)) {
    const stable = findStableGardenBin();
    if (stable) return `${shellEscape(process.execPath)} ${shellEscape(stable)}`;
  }
  // Use absolute path for node so hooks work in minimal shell environments
  return `${shellEscape(process.execPath)} ${shellEscape(direct)}`;
}

// Companion runner for the per-tool-call Claude hook. The hook fires on every
// tool completion by every agent, so routing it through cli.js would parse the
// entire command+dashboard bundle on each fire. dist/hook.js (built from
// src/hook-entry.ts) bundles only the hook dispatcher's import closure — ~60%
// smaller — so the node cold-start is cheaper. Worker settings.json hook
// commands invoke this; cli.js keeps its own `_claude-hook` route so workers
// whose settings predate this still work until their next refresh. Pre-escaped
// per token like resolveGardenRunner, so callers must NOT re-wrap it.
//
// hook.js lives next to the real cli.js, so we locate that and swap the
// basename. In dev it is the sibling hook-entry.ts. In dist, argv[1] may be
// the npm bin symlink (e.g. /opt/homebrew/bin/garden, basename "garden", not
// "cli.js"), so we resolve through symlinks to find the real dist/ — except in
// a worktree, where we prefer the stable global for the same ephemerality
// reason as resolveGardenRunner.
export function resolveHookRunner(): string {
  const direct = path.resolve(process.argv[1]);

  if (direct.endsWith(".ts")) {
    const dir = path.dirname(direct);
    const gardenRoot = path.dirname(dir);
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    const script = path.join(dir, "hook-entry.ts");
    return fs.existsSync(tsxBin)
      ? `${shellEscape(tsxBin)} ${shellEscape(script)}`
      : `npx tsx ${shellEscape(script)}`;
  }

  if (direct.includes(WORKTREE_MARKER)) {
    const stable = findStableGardenBin();
    // findStableGardenBin already returns a realpath'd dist/cli.js; fall back
    // to the worktree's own dist when no stable global exists.
    const cliJs = stable ?? direct;
    return `${shellEscape(process.execPath)} ${shellEscape(path.join(path.dirname(cliJs), "hook.js"))}`;
  }

  // Outside a worktree, argv[1] may be a bin symlink; resolve to the real
  // cli.js so hook.js maps to its actual dist sibling.
  let cliJs = direct;
  try { cliJs = fs.realpathSync(direct); } catch { /* use argv[1] as-is */ }
  return `${shellEscape(process.execPath)} ${shellEscape(path.join(path.dirname(cliJs), "hook.js"))}`;
}

// Walk PATH looking for a `garden` executable, then resolve through symlinks
// to the underlying file. The npm-linked global is itself a symlink chain:
// /opt/homebrew/bin/garden -> ../lib/node_modules/garden/dist/cli.js
//   -> /Users/joshua/code/keychange/garden/dist/cli.js
// Returns null when no stable target exists (e.g., no `npm link` set up,
// or the symlink target was deleted) so the caller can fall back gracefully.
// Skips paths that themselves live inside a worktree, since chasing a
// worktree-rooted symlink would defeat the entire stability check.
export function findStableGardenBin(): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "garden");
    try {
      const real = fs.realpathSync(candidate);
      if (real.endsWith(".js") && !real.includes(WORKTREE_MARKER)) return real;
    } catch { /* not in this dir */ }
  }
  return null;
}
