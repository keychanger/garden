// Command: garden stats — the telemetry read surface. Aggregates the append-only
// event ledger (src/dashboard/telemetry.ts) into a per-config comparison so the
// operator can see which model / provider / harness / workflow lands the best
// work at the lowest token cost with the least hand-holding. Read-only; JSON when
// piped, a table in a TTY.
//
// The unit of comparison is the config group (default: harness/provider/model/
// workflow). Every metric event carries a workerId; worker.created carries the
// config for that workerId. We build the join from the FULL created history
// (never time-windowed) so a worker created before a `--since` window still
// resolves its config, then window only the metric events.
import { readTelemetryEvents, type LedgerEvent } from "../dashboard/telemetry.js";
import { getProject } from "../config.js";
import { output, isTTY } from "../output.js";

const GROUP_AXES = [
  "config", "model", "provider", "harness", "workflow", "crew", "rules", "version",
] as const;
type GroupAxis = typeof GROUP_AXES[number];

interface CreatedSnapshot {
  harness?: string;
  provider?: string | null;
  model?: string | null;
  workflow?: string;
  crew?: string | null;
  rulesHash?: string;
  gardenVersion?: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function dash(v: unknown): string {
  return v === undefined || v === null || v === "" ? "-" : String(v);
}

function groupKey(axis: GroupAxis, s: CreatedSnapshot | undefined): string {
  if (!s) return "(unknown)";
  switch (axis) {
    case "model": return dash(s.model);
    case "provider": return s.provider ? String(s.provider) : "(none)";
    case "harness": return dash(s.harness);
    case "workflow": return dash(s.workflow);
    case "crew": return s.crew ? String(s.crew) : "(none)";
    case "rules": return dash(s.rulesHash);
    case "version": return dash(s.gardenVersion);
    case "config":
    default:
      return `${dash(s.harness)}/${s.provider ? s.provider : "-"}/${s.model ? s.model : "-"}/${dash(s.workflow)}`;
  }
}

interface Agg {
  key: string;
  workers: Set<string>;
  merges: number;
  reviews: number;
  clean: number;
  failed: number;
  fixLines: number;
  reviewMs: number;
  reviewMsN: number;
  interventions: number;
  autoContinues: number;
  // worker.tokens is cumulative, so a worker's total is its highest-mergeCount
  // sample; keep that per worker and sum across the group.
  tokensByWorker: Map<string, { mergeCount: number; output: number }>;
}

interface StatRow {
  group: string;
  workers: number;
  merges: number;
  reviews: number;
  cleanPct: number | null;
  failedPct: number | null;
  avgFixLines: number | null;
  avgReviewMs: number | null;
  outputTokens: number;
  outputTokensPerMerge: number | null;
  interventions: number;
  interventionsPerMerge: number | null;
  autoContinues: number;
}

// Parse Nd / Nh / Nm into ms. Returns null on an unparseable value.
function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+)([dhm])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
  return n * unit;
}

interface Options {
  axis: GroupAxis;
  project?: string;
  sinceMs?: number;
  sinceLabel?: string;
}

function parseArgs(args: string[]): Options {
  const opts: Options = { axis: "config" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--by") {
      const v = args[++i];
      if (!GROUP_AXES.includes(v as GroupAxis)) {
        throw new Error(`Unknown --by axis '${v}'. Valid: ${GROUP_AXES.join(", ")}.`);
      }
      opts.axis = v as GroupAxis;
    } else if (a === "--since") {
      const v = args[++i];
      const ms = v ? parseDuration(v) : null;
      if (ms === null) throw new Error(`Invalid --since '${v}'. Use Nd, Nh, or Nm (e.g. 7d).`);
      opts.sinceMs = Date.now() - ms;
      opts.sinceLabel = v;
    } else if (a === "--project" || a === "-p") {
      opts.project = getProject(args[++i]).name;
    } else {
      throw new Error(`Unknown argument '${a}'. See 'garden stats --help'.`);
    }
  }
  return opts;
}

function aggregate(events: LedgerEvent[], opts: Options): StatRow[] {
  // Join config from the full created history — never time-windowed.
  const configByWorker = new Map<string, CreatedSnapshot>();
  for (const e of events) {
    if (e.event === "worker.created") configByWorker.set(e.workerId, e as unknown as CreatedSnapshot);
  }

  const groups = new Map<string, Agg>();
  const get = (key: string): Agg => {
    let a = groups.get(key);
    if (!a) {
      a = {
        key, workers: new Set(), merges: 0, reviews: 0, clean: 0, failed: 0,
        fixLines: 0, reviewMs: 0, reviewMsN: 0, interventions: 0, autoContinues: 0,
        tokensByWorker: new Map(),
      };
      groups.set(key, a);
    }
    return a;
  };

  for (const e of events) {
    if (opts.sinceMs !== undefined && Date.parse(e.ts) < opts.sinceMs) continue;
    const a = get(groupKey(opts.axis, configByWorker.get(e.workerId)));
    a.workers.add(e.workerId);
    switch (e.event) {
      case "merge":
        a.merges++;
        break;
      case "review.verdict": {
        a.reviews++;
        const v = String(e.verdict ?? "").toLowerCase();
        if (v === "clean" || v === "aligned") a.clean++;
        else if (v === "failed") a.failed++;
        a.fixLines += num(e.fixInsertions) + num(e.fixDeletions);
        if (typeof e.durationMs === "number") {
          a.reviewMs += e.durationMs;
          a.reviewMsN++;
        }
        break;
      }
      case "operator.action":
        a.interventions++;
        break;
      case "continue.dispatched":
        a.autoContinues++;
        break;
      case "worker.tokens": {
        const mergeCount = num(e.mergeCount);
        const prev = a.tokensByWorker.get(e.workerId);
        if (!prev || mergeCount >= prev.mergeCount) {
          a.tokensByWorker.set(e.workerId, { mergeCount, output: num(e.outputTokens) });
        }
        break;
      }
      default:
        break;
    }
  }

  const rows: StatRow[] = [];
  for (const a of groups.values()) {
    let outputTokens = 0;
    for (const t of a.tokensByWorker.values()) outputTokens += t.output;
    const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);
    rows.push({
      group: a.key,
      workers: a.workers.size,
      merges: a.merges,
      reviews: a.reviews,
      cleanPct: pct(a.clean, a.reviews),
      failedPct: pct(a.failed, a.reviews),
      avgFixLines: a.reviews > 0 ? Math.round((a.fixLines / a.reviews) * 10) / 10 : null,
      avgReviewMs: a.reviewMsN > 0 ? Math.round(a.reviewMs / a.reviewMsN) : null,
      outputTokens,
      outputTokensPerMerge: a.merges > 0 ? Math.round(outputTokens / a.merges) : null,
      interventions: a.interventions,
      interventionsPerMerge: a.merges > 0 ? Math.round((a.interventions / a.merges) * 100) / 100 : null,
      autoContinues: a.autoContinues,
    });
  }
  // Most-active config first; workers as a stable tiebreak.
  rows.sort((x, y) => y.merges - x.merges || y.workers - x.workers || x.group.localeCompare(y.group));
  return rows;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtPct(v: number | null): string {
  return v === null ? "-" : `${v}%`;
}

function fmtSecs(ms: number | null): string {
  return ms === null ? "-" : `${Math.round(ms / 1000)}s`;
}

function renderTable(rows: StatRow[], opts: Options): string {
  const scope = [
    `by ${opts.axis}`,
    opts.project ? `project ${opts.project}` : null,
    opts.sinceLabel ? `since ${opts.sinceLabel}` : null,
  ].filter(Boolean).join(", ");

  const header = ["config", "w", "merges", "reviews", "clean%", "fix̄", "fail%", "rev̄", "out/mrg", "intv/m"];
  const body = rows.map(r => [
    r.group,
    String(r.workers),
    String(r.merges),
    String(r.reviews),
    fmtPct(r.cleanPct),
    r.avgFixLines === null ? "-" : String(r.avgFixLines),
    fmtPct(r.failedPct),
    fmtSecs(r.avgReviewMs),
    r.outputTokensPerMerge === null ? "-" : fmtK(r.outputTokensPerMerge),
    r.interventionsPerMerge === null ? "-" : String(r.interventionsPerMerge),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...body.map(row => row[i].length)));
  const line = (cells: string[]): string =>
    "  " + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");

  const out: string[] = ["", `  Telemetry — ${scope}`, "", `\x1b[1m${line(header)}\x1b[0m`];
  for (const row of body) out.push(line(row));
  out.push("");
  return out.join("\n");
}

export async function stats(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const rows = aggregate(readTelemetryEvents({ project: opts.project }), opts);

  if (!isTTY) {
    output({ axis: opts.axis, project: opts.project ?? null, since: opts.sinceLabel ?? null, rows });
    return;
  }
  if (rows.length === 0) {
    console.log(
      opts.sinceLabel || opts.project
        ? "No telemetry events match that filter yet."
        : "No telemetry recorded yet. It accrues as workers are created, reviewed, and merged.",
    );
    return;
  }
  console.log(renderTable(rows, opts));
}
