// `garden resurrect [<worker>] [--search <expr>] [-p <project>]` — list killed
// workers rebuildable from their telemetry tombstones, or rebuild one.
//
// Without a name: the tombstone list, newest kill first — each row shows when
// it died, what it was doing, and whether its transcript (the conversation)
// is still on disk. `--search` narrows by name/task/branch AND transcript
// content, so "the worker that did the schema migration" is findable without
// remembering its slug. With a name: rebuild that worker — worktree back at
// its original path, entry back in the registry with history counters intact,
// session resumed in a fresh hidden window (deferred to the next attach when
// the dashboard isn't running).
import { output, isTTY } from "../output.js";
import {
  listTombstones, searchTombstones, tombstoneTranscript, resurrectWorker,
  type Tombstone,
} from "../dashboard/resurrect.js";

const LIST_LIMIT = 20;

export async function resurrect(args: string[]): Promise<void> {
  let name: string | undefined;
  let search: string | undefined;
  let project: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--search") search = args[++i];
    else if (a === "-p" || a === "--project") project = args[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown flag '${a}'. Usage: garden resurrect [<worker>] [--search <expr>] [-p <project>]`);
    else if (!name) name = a;
    else throw new Error(`Unexpected argument '${a}'.`);
  }
  if (args.includes("--search") && !search) {
    throw new Error("--search requires an expression.");
  }

  let tombstones = listTombstones({ project });
  if (search) tombstones = searchTombstones(tombstones, search);

  if (!name) {
    printList(tombstones, search);
    return;
  }

  const t = resolveTombstone(tombstones, name);
  const outcome = resurrectWorker(t);
  if (!isTTY) {
    output(outcome);
    return;
  }
  console.log(`Resurrected ${outcome.project}/${outcome.worker}`);
  console.log(`  worktree  ${outcome.worktreePath}`);
  console.log(`  branch    ${outcome.branchName} (from ${outcome.startedFrom})`);
  console.log(outcome.resumed
    ? "  session   resumed — reach it via the dashboard worker cycle"
    : "  session   not resumed yet");
  for (const n of outcome.notes) console.log(`  note      ${n}`);
}

// Same match tiers as resolveWorkerArg (exact -> prefix -> substring), but
// over tombstones. Several kills of the SAME project/worker collapse to the
// newest lifetime; matches on genuinely different workers stay ambiguous.
function resolveTombstone(tombstones: Tombstone[], arg: string): Tombstone {
  if (tombstones.length === 0) {
    throw new Error("No resurrectable workers. Tombstones are written at kill time — workers killed before this feature shipped have none.");
  }
  const lower = arg.toLowerCase();
  const tiers = [
    tombstones.filter(t => t.worker === arg),
    tombstones.filter(t => t.worker.toLowerCase().startsWith(lower)),
    tombstones.filter(t => t.worker.toLowerCase().includes(lower)),
  ];
  for (const tier of tiers) {
    if (tier.length === 0) continue;
    const identities = new Set(tier.map(t => `${t.project}/${t.worker}`));
    if (identities.size > 1) {
      throw new Error(
        `'${arg}' is ambiguous: ${[...identities].join(", ")}. Use the full name and -p <project>.`,
      );
    }
    // listTombstones sorts newest-first, so the first hit is the latest lifetime.
    return tier[0];
  }
  throw new Error(`No tombstone matches '${arg}'. Run \`garden resurrect\` to list them.`);
}

interface TombstoneRow {
  project: string;
  worker: string;
  killedAt: string;
  workflow: string;
  task: string;
  mergeCount: number;
  resurrectable: boolean;
}

function printList(tombstones: Tombstone[], search: string | undefined): void {
  const rows: TombstoneRow[] = tombstones.slice(0, LIST_LIMIT).map(t => ({
    project: t.project,
    worker: t.worker,
    killedAt: t.killedAt,
    workflow: t.workflow,
    task: t.entry.task ?? "",
    mergeCount: t.entry.mergeCount ?? 0,
    resurrectable: tombstoneTranscript(t) !== null,
  }));
  if (!isTTY) {
    output(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(search ? `No tombstones match '${search}'.` : "No resurrectable workers.");
    return;
  }
  const now = Date.now();
  const nameWidth = Math.max(...rows.map(r => `${r.project}/${r.worker}`.length));
  console.log("");
  for (const r of rows) {
    const ago = formatAgo(now - Date.parse(r.killedAt)).padStart(4);
    const loc = `${r.project}/${r.worker}`.padEnd(nameWidth);
    const merges = r.mergeCount > 0 ? `${r.mergeCount} merge${r.mergeCount === 1 ? "" : "s"}` : "unmerged";
    const dead = r.resurrectable ? "" : "  \x1b[2m(transcript gone)\x1b[0m";
    const task = r.task ? `  ${r.task.slice(0, 60)}` : "";
    console.log(`  \x1b[2m${ago}\x1b[0m  \x1b[1m${loc}\x1b[0m  \x1b[2m${merges}\x1b[0m${task}${dead}`);
  }
  console.log("");
  if (tombstones.length > LIST_LIMIT) {
    console.log(`  \x1b[2m(${tombstones.length - LIST_LIMIT} older not shown — narrow with --search or -p)\x1b[0m`);
    console.log("");
  }
  console.log("  \x1b[2mgarden resurrect <worker> brings one back\x1b[0m");
  console.log("");
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
