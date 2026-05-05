// Resolve the absolute command line to invoke garden's CLI from a child
// process. Used by every code path that spawns a detached subprocess (Claude
// Code hooks, post-merge auto-continue, the worker pre-push hook, etc.). Lives
// in its own leaf module so it can be imported from anywhere — including
// hooks/default.ts — without dragging the rest of dashboard/create.ts into
// the import graph. Importing from create.ts here would close a module-init
// cycle (workflows/default.ts -> hooks/default.ts -> create.ts -> poller.ts
// -> workflows/index.ts -> workflows/default.ts). Note: severing that cycle
// did not eliminate the getter on defaultWorkflow.hookHandlers — a separate
// cycle through header.ts still requires it (see workflows/default.ts).
import fs from "node:fs";
import path from "node:path";

export function resolveGardenRunner(): string {
  const gardenBin = path.resolve(process.argv[1]);
  if (gardenBin.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(gardenBin));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    return fs.existsSync(tsxBin) ? `${tsxBin} ${gardenBin}` : `npx tsx ${gardenBin}`;
  }
  // Use absolute path for node so hooks work in minimal shell environments
  return `${process.execPath} ${gardenBin}`;
}
