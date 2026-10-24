// Guard for the shape of the runtime import graph (real esbuild, no mocks).
//
// Modules in an import cycle are evaluated in whatever order a bundle first
// reaches them, so a top-level read of a sibling's export (a const table, a
// registry.set call) can throw a TDZ ReferenceError, or read undefined, in one
// bundle and not another; workflows/types.ts records that happening here once.
// The state handlers and the workflow registry still form one cycle by
// construction: the workflow definitions import the handlers, and the handlers
// consult the registry. Until the poller's window lifecycle moved to
// poller-window.ts, workers.ts, validate.ts and create.ts reached that cycle
// through poller.ts, and 21 modules shared it.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const ROOT = path.resolve(__dirname, "../..");

// Every module allowed to sit in a runtime import cycle. Remove entries as
// cycles are broken; a module missing from this list that joins a cycle fails.
const HANDLER_CYCLE = [
  "src/dashboard/poller-ci-fix.ts",
  "src/dashboard/poller-holistic-review.ts",
  "src/dashboard/poller-merge.ts",
  "src/dashboard/poller-resolve.ts",
  "src/dashboard/poller-review.ts",
  "src/dashboard/poller-state.ts",
  "src/dashboard/roles.ts",
  "src/dashboard/workflows/default.ts",
  "src/dashboard/workflows/designer.ts",
  "src/dashboard/workflows/grow.ts",
  "src/dashboard/workflows/index.ts",
  "src/dashboard/workflows/planner.ts",
];
// ensureDashboard calls validateAndHeal, and validate.ts recreates the shell
// and growhouse windows create.ts defines.
const DASHBOARD_PAIR = ["src/dashboard/create.ts", "src/dashboard/validate.ts"];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

// Static value imports between source files, as esbuild resolves them. A
// TypeScript import used only as a type is left unresolved and `import type`
// is dropped, so neither appears. Dynamic imports are left out: they run after
// the importing module has finished evaluating, so they cannot reorder it.
async function runtimeImportGraph(): Promise<Map<string, string[]>> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: sourceFiles(path.join(ROOT, "src")),
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    outdir: path.join(os.tmpdir(), "garden-import-cycles"),
    logLevel: "silent",
    define: { __GARDEN_VERSION__: '"test"', __GARDEN_COMMIT__: '"test"' },
  });
  const graph = new Map<string, string[]>();
  for (const [file, input] of Object.entries(result.metafile.inputs)) {
    if (!file.startsWith("src/")) continue;
    graph.set(file, input.imports
      .filter((i) => i.kind === "import-statement" && !i.external && i.path.startsWith("src/"))
      .map((i) => i.path));
  }
  return graph;
}

// Tarjan's strongly connected components, keeping the ones that are cycles.
function importCycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) cycles.push(component.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return cycles.sort((a, b) => b.length - a.length);
}

describe("runtime import cycles (real esbuild)", () => {
  it("puts no module outside the known cycles in one", async () => {
    const cycles = importCycles(await runtimeImportGraph());
    const allowed = new Set([...HANDLER_CYCLE, ...DASHBOARD_PAIR]);
    const strays = cycles.flat().filter((m) => !allowed.has(m));
    expect(strays, cycles.map((c) => `[${c.length}] ${c.join(", ")}`).join("\n")).toEqual([]);
  });

  it("keeps the dashboard builders out of the state-handler cycle", async () => {
    const cycles = importCycles(await runtimeImportGraph());
    const handlerCycle = cycles.find((c) => c.includes(HANDLER_CYCLE[0])) ?? [];
    expect(handlerCycle.filter((m) => DASHBOARD_PAIR.includes(m)), handlerCycle.join(", ")).toEqual([]);
  });
});
