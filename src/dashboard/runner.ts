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

export function resolveGardenRunner(): string {
  const gardenBin = path.resolve(process.argv[1]);
  if (gardenBin.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(gardenBin));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    return fs.existsSync(tsxBin)
      ? `${shellEscape(tsxBin)} ${shellEscape(gardenBin)}`
      : `npx tsx ${shellEscape(gardenBin)}`;
  }
  // Use absolute path for node so hooks work in minimal shell environments
  return `${shellEscape(process.execPath)} ${shellEscape(gardenBin)}`;
}
