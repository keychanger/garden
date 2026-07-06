// Command: garden queue [project] — the merge pipeline at a glance. Shows the
// workers whose code is in flight toward (or blocked before) merge, with the
// serial merge-queue order and CI markers. Complements `garden status`, which
// lists every worker; this is scoped to the pipeline and answers "what merges
// next, and what's stuck?".
import { readRegistry, type WorkerEntry } from "../dashboard/registry.js";
import { output, isTTY } from "../output.js";

// Mirrors poller-ci-fix.ts CI_FIX_BUDGET; inlined so this command doesn't pull
// in the poller graph.
const CI_FIX_BUDGET_DISPLAY = 3;

// Display order within a project: the serial merge queue first, then work still
// in review/repair, then blocked workers.
const PIPELINE_ORDER = ["merge-pending", "reviewing", "resolving", "ci-fixing", "failing"];

interface QueueRow {
  worker: string;
  state: string;       // display state ("merging" for merge-pending)
  prState: string;
  sinceMs: number | null;
  queuePos?: number;   // 1-based serial position for merge-pending (1 merges next)
  ci?: string;         // CI marker for ci-fixing / failing-ci rows
}

function isPipeline(e: WorkerEntry): boolean {
  return e.prState !== undefined && PIPELINE_ORDER.includes(e.prState);
}

function ciMarker(e: WorkerEntry): string | undefined {
  if (e.prState === "ci-fixing") {
    return `CI fix ${e.ciFixAttempts ?? 1}/${CI_FIX_BUDGET_DISPLAY}`;
  }
  if (e.prState === "failing" && e.failingReason === "ci") {
    return e.failingSha ? `CI ✗ ${e.failingSha.slice(0, 7)}` : "CI ✗";
  }
  return undefined;
}

function buildRows(entries: WorkerEntry[], now: number): QueueRow[] {
  const pipeline = entries.filter(isPipeline);
  // Serial merge order: merge-pending workers by mergePendingAt ascending
  // (earliest merges first) — the poller's own gate ordering.
  const mergeOrder = pipeline
    .filter(e => e.prState === "merge-pending")
    .sort((a, b) => (a.mergePendingAt ?? "").localeCompare(b.mergePendingAt ?? ""))
    .map(e => e.name);

  return pipeline
    .map(e => {
      const pos = e.prState === "merge-pending" ? mergeOrder.indexOf(e.name) + 1 : undefined;
      return {
        worker: e.name,
        state: e.prState === "merge-pending" ? "merging" : e.prState!,
        prState: e.prState!,
        sinceMs: e.lastStateChangeAt !== undefined ? now - e.lastStateChangeAt : null,
        queuePos: pos,
        ci: ciMarker(e),
      };
    })
    .sort((a, b) => {
      const oa = PIPELINE_ORDER.indexOf(a.prState);
      const ob = PIPELINE_ORDER.indexOf(b.prState);
      if (oa !== ob) return oa - ob;
      // Within merge-pending, order by queue position.
      return (a.queuePos ?? 0) - (b.queuePos ?? 0);
    });
}

export async function queue(args: string[]): Promise<void> {
  const only = args[0];
  const registry = readRegistry();
  const now = Date.now();

  const projects = Object.entries(registry.workers)
    .filter(([name]) => !only || name === only)
    .map(([name, entries]) => ({ name, rows: buildRows(entries, now) }))
    .filter(p => p.rows.length > 0);

  if (!isTTY) {
    output({ projects });
    return;
  }

  if (projects.length === 0) {
    console.log(only ? `No workers in the merge pipeline for '${only}'.` : "Merge pipeline is empty.");
    return;
  }

  console.log("");
  console.log("  Merge pipeline");
  for (const p of projects) {
    console.log("");
    console.log(`  \x1b[1m${p.name}\x1b[0m`);
    const nameWidth = Math.max(...p.rows.map(r => r.worker.length));
    for (const r of p.rows) {
      const pos = r.queuePos ? `${r.queuePos}.` : "  ";
      const next = r.queuePos === 1 ? " \x1b[2m← next\x1b[0m" : "";
      // Pad the visible age (not the ANSI-wrapped string) so the CI column lines up.
      const since = `\x1b[2m${(r.sinceMs !== null ? formatAgo(r.sinceMs) : "").padEnd(4)}\x1b[0m`;
      const ci = r.ci ? `  ${colorCi(r.ci)}` : "";
      const state = colorState(r.prState, r.state.padEnd(13));
      console.log(`    ${pos} ${r.worker.padEnd(nameWidth)}  ${state} ${since}${ci}${next}`);
    }
  }
  console.log("");
}

function colorState(prState: string, text: string): string {
  if (prState === "failing") return `\x1b[1;31m${text}\x1b[0m`;
  if (prState === "merge-pending") return `\x1b[36m${text}\x1b[0m`;
  return text;
}

function colorCi(marker: string): string {
  return marker.startsWith("CI ✗") ? `\x1b[31m${marker}\x1b[0m` : `\x1b[33m${marker}\x1b[0m`;
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
