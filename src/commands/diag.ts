// `garden diag handoff` — reads the most recent status-pane corruption
// snapshot (written by the auto-detector in src/dashboard/header.ts), wraps
// the evidence in a fix briefing, and spawns a fresh garden worker pre-loaded
// with the briefing as its first prompt. Mirrors handoff.ts's seedFile pattern
// rather than calling `garden handoff` to avoid a subprocess + shell-escape.
//
// REMOVE WITH ALL OTHER diag- PLUMBING once the underlying bug is fixed.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { newWorker } from "../dashboard/workers.js";

export async function diag(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "handoff") return handoffFromLatestSnapshot();
  if (!sub) {
    throw new Error("Usage: garden diag handoff");
  }
  throw new Error(`Unknown diag subcommand: ${sub}. Usage: garden diag handoff`);
}

function handoffFromLatestSnapshot(): void {
  const snapshot = findLatestSnapshot();
  if (!snapshot) {
    throw new Error(
      `No diag-snap-*.txt files found in ${SESSIONS_DIR}. `
      + "The auto-detector hasn't fired yet, or all snapshots have been deleted.",
    );
  }

  const evidence = fs.readFileSync(snapshot.path, "utf8");
  const briefing = buildBriefing(snapshot.path, evidence);

  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(
    seedsDir,
    `seed-diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  fs.writeFileSync(seedFile, briefing);

  const newName = newWorker({
    projectName: "garden",
    seedMessageFile: seedFile,
    background: true,
  });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw new Error(
      "Failed to spawn diagnostic worker on 'garden'. "
      + "Is the dashboard running? Check 'garden health'.",
    );
  }

  console.log(`Dispatched diagnostic worker: garden/${newName}`);
  console.log(`Snapshot: ${snapshot.path}`);
}

function findLatestSnapshot(): { path: string; mtimeMs: number } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return null;
  }
  let latest: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.startsWith("diag-snap-") || !name.endsWith(".txt")) continue;
    const full = path.join(SESSIONS_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { path: full, mtimeMs: stat.mtimeMs };
      }
    } catch { /* ignore unreadable */ }
  }
  return latest;
}

function buildBriefing(snapshotPath: string, evidence: string): string {
  return `[diag handoff] status-pane duplicate-row bug — auto-captured

A diagnostic auto-detector in the dashboard's status-pane render loop has captured a snapshot of the bug described below. Your task: confirm the root cause, write a fix, verify it, and remove ALL of the diagnostic plumbing as part of your merge.

# Symptom

The dashboard status pane intermittently renders duplicate adjacent worker rows after a layout transition (e.g. when the usage pane goes from "not rendered" to "rendered" via \`garden usage refresh\`). The auto-detector identifies this shape: the *visible* pane (\`tmux capture-pane\`) contains two adjacent identical non-blank lines, while the in-memory \`$cur\` (the bash render loop's source of truth) does not. The bug auto-heals at the next outer-loop iteration of the bash render loop (≤60s), which is why earlier manual capture attempts kept missing it.

# Leading hypothesis (confirm or refute with the evidence below)

The spinner inner loop in \`buildStatusCommand\` (\`src/dashboard/header.ts\`) repaints braille-bearing lines from \`$cur\` at fixed line numbers using \`\\033[%d;1H\`. After a layout transition shifts the pre-baked file's row positions, the spinner overlay may be repainting stale-position content over freshly painted file content — producing the duplicate visible-row symptom while \`$cur\` and the file remain internally consistent.

# Evidence (snapshot: ${snapshotPath})

\`\`\`
${evidence}
\`\`\`

# What to do

1. Read the evidence above. Compare \`## cur\`, \`## file\`, and \`## visible\` line-by-line. Note where they diverge — that's the bug surface.
2. Read \`src/dashboard/header.ts\` (especially \`buildStatusCommand\` and \`writeQuickStatus\` / \`resizeAndSignal\`) to understand the render pipeline.
3. Confirm or refute the hypothesis. If confirmed, fix the spinner overlay or the trap path so visible always tracks \`$cur\`. If refuted, identify the actual cause from the evidence.
4. Write a vitest unit test that catches the regression.
5. Verify the fix interactively if possible: respawn the status pane, repro the trigger (\`garden usage refresh\` from an empty-usage state), confirm the bug doesn't recur.
6. **Remove the diagnostic plumbing in the same PR as the fix.** Cleanup checklist below.

# Cleanup checklist (REMOVE EVERYTHING — single revert-shaped diff)

- \`src/dashboard/header.ts\`:
  - Remove the \`diag_count=0\` + \`sd='...'\` lines from the prelude.
  - Remove the entire \`-------- diag auto-detector --------\` block in the outer loop.
  - Remove the \`cd='...'\` line and the USR2 trap (\`trap 'printf %s "$cur" > "$cd"' USR2\`).
  - Drop \`export\` from \`STATUS_RENDERED_FILE\` and remove the \`STATUS_CUR_DUMP_FILE\` const.
- \`src/dashboard/index.ts\`: remove the \`_diag-status\` and \`_diag-alert\` dispatch blocks.
- Delete files:
  - \`src/dashboard/diag-status.ts\`
  - \`src/dashboard/diag-alert.ts\`
  - \`src/commands/diag.ts\` (this file)
- \`src/commands/index.ts\`: remove the \`diag\` import and registration.
- \`src/cli.ts\`: remove the \`diag handoff\` help line.
- Delete leftover snapshots: \`rm ~/.garden/sessions/diag-snap-*.txt\`
- Run \`grep -r 'diag-' src/\` after deletion. Should return zero hits.

# Branch/commit guidance

You're a garden worker — commit on your assigned branch (don't \`git checkout -b\`). First commit message should explain the bug and the fix approach. Final commit (or part of the fix commit) removes all diagnostic plumbing per the checklist above. Pre-push: run \`npm run lint && npm run build && npm run test:coverage && npm run test:integration\`.
`;
}
