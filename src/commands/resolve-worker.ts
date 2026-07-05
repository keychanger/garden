// Shared CLI worker-argument resolver. `kick` / `bounce` / `hold` / `pause` /
// `resume` all take a worker name and each open-coded the same exact-match scan
// across every project. This resolves the argument to a single worker with
// forgiving matching, so the operator can type a prefix ("blea") instead of the
// full three-word name ("bleak-hoar-glow").
import { readRegistry, type WorkerEntry } from "../dashboard/registry.js";
import { readDashState } from "../dashboard/state.js";
import { parseWorkerWindow } from "../dashboard/window-names.js";

export interface ResolvedWorker {
  project: string;
  worker: string;
  entry: WorkerEntry;
}

// Resolve `arg` to exactly one worker. Tiers are tried in order; the first tier
// with any match decides the outcome (one match wins, several is ambiguous):
// exact name → unique case-insensitive prefix → unique case-insensitive
// substring. `.` resolves to the dashboard's focused worker. Throws a helpful
// message when nothing matches (listing known workers) or several do.
export function resolveWorkerArg(arg: string): ResolvedWorker {
  const all: ResolvedWorker[] = [];
  const registry = readRegistry();
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) all.push({ project, worker: entry.name, entry });
  }
  if (all.length === 0) throw new Error("No workers exist.");

  if (arg === ".") {
    const focused = focusedWorker(all);
    if (focused) return focused;
    throw new Error(
      "`.` resolves to the focused worker, but no worker pane is focused. Name the worker.",
    );
  }

  const lower = arg.toLowerCase();
  const tiers: ResolvedWorker[][] = [
    all.filter(w => w.worker === arg),
    all.filter(w => w.worker.toLowerCase().startsWith(lower)),
    all.filter(w => w.worker.toLowerCase().includes(lower)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) throw ambiguousError(arg, tier);
  }
  throw noMatchError(arg, all);
}

function focusedWorker(all: ResolvedWorker[]): ResolvedWorker | null {
  const win = readDashState().activeWindowName;
  if (!win) return null;
  const parsed = parseWorkerWindow(win);
  if (!parsed) return null;
  return all.find(w => w.project === parsed.project && w.worker === parsed.worker) ?? null;
}

function ambiguousError(arg: string, matches: ResolvedWorker[]): Error {
  const list = matches
    .map(m => `  ${m.project}/${m.worker} (${m.entry.prState ?? "working"})`)
    .join("\n");
  return new Error(`'${arg}' matches multiple workers:\n${list}\nUse a more specific name.`);
}

function noMatchError(arg: string, all: ResolvedWorker[]): Error {
  const names = all.map(w => w.worker).sort();
  return new Error(`No worker matches '${arg}'. Known workers: ${names.join(", ")}`);
}
