// Read-only holistic-review backtest harness (validation layer L2).
//
// Replays the production holistic review against a PAST completed multi-phase
// worker, with zero risk to any live repo. The new bookkeeping fields
// (baseBranchSha, holisticTouchedFiles, mergeCount) don't exist on historical
// workers, so this reconstructs the cumulative-diff endpoints from the dashboard
// log (merge events → mergeCount + timestamps) joined to the project repo's
// base-branch reflog (timestamp → base SHA before/after the worker's merges).
// It then runs the SAME production functions (resolveHolisticDiff, getCommitLogRange,
// buildHolisticFinalReviewPrompt) so the backtest exercises real code paths, and
// writes the prompt + scoped diff to $TMPDIR for review. With --run it pipes the
// prompt through `claude -p` (opus) and saves the findings.
//
// Reflog recovery is fragile (90-day expiry, operator-machine-local, fast-forward
// merges leave no per-cycle SHA in the log). When it can't reconstruct, pass
// explicit endpoints: `_holistic-backtest <project> <worker> --from <sha> --to <ref>`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { SESSIONS_DIR, tryGetProject } from "../config.js";
import { findWorkerByName, type WorkerEntry } from "./registry.js";
import {
  getChangedFilesBetween, getCommitLogRange, resolveHolisticDiff,
} from "./git.js";
import { buildHolisticFinalReviewPrompt } from "./prompts.js";

const LOG_FILE = path.join(SESSIONS_DIR, "dashboard.log");

interface ReflogEntry { epoch: number; sha: string; }

// Parse `git reflog show <ref> --date=unix` → ascending-by-time [{epoch, sha}].
function readBaseReflog(repoPath: string, baseBranch: string): ReflogEntry[] {
  const out = execFileSync("git", ["reflog", "show", baseBranch, "--date=unix"], {
    cwd: repoPath, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
  });
  const entries: ReflogEntry[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\w+)\s+\S+@\{(\d+)\}:/);
    if (m) entries.push({ sha: m[1], epoch: Number(m[2]) });
  }
  return entries.sort((a, b) => a.epoch - b.epoch);
}

// Epoch (seconds) of each actual merge for this worker, ascending. A single
// successful merge logs "merged to base branch" TWICE — once from mergeToBase
// (src "git", the real base push) and once from finalizeMerge's poller line —
// so matching on msg+worker alone would double every worker's merge count and
// let a single-merge (non-multi-phase) worker slip past the `mergeCount < 2`
// guard. Count only the src:"git" line: it fires exactly once per base push,
// including a resumed interrupted merge (whose poller line never ran).
export function workerMergeEpochs(logText: string, worker: string): number[] {
  const epochs: number[] = [];
  for (const line of logText.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; src?: string; worker?: string; msg?: string };
      if (e.src === "git" && e.worker === worker && e.msg === "merged to base branch" && e.ts) {
        epochs.push(Date.parse(e.ts) / 1000);
      }
    } catch { /* skip malformed line */ }
  }
  return epochs.sort((a, b) => a - b);
}

export function closestIndex(entries: ReflogEntry[], epoch: number): number {
  let best = 0, bestDelta = Infinity;
  entries.forEach((e, i) => {
    const d = Math.abs(e.epoch - epoch);
    if (d < bestDelta) { bestDelta = d; best = i; }
  });
  return best;
}

export function parseFlags(args: string[]): { from?: string; to?: string; base?: string; run: boolean } {
  const out: { from?: string; to?: string; base?: string; run: boolean } = { run: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from") out.from = args[++i];
    else if (args[i] === "--to") out.to = args[++i];
    else if (args[i] === "--base") out.base = args[++i];
    else if (args[i] === "--run") out.run = true;
  }
  return out;
}

export async function runHolisticBacktest(args: string[]): Promise<void> {
  const project = args[0];
  const worker = args[1];
  if (!project || !worker) {
    console.error("usage: garden dashboard _holistic-backtest <project> <worker> [--from <sha>] [--to <ref>] [--base <branch>] [--run]");
    return;
  }
  const cfg = tryGetProject(project);
  if (!cfg) { console.error(`Unknown project: ${project}`); return; }
  const repoPath = cfg.path;
  const flags = parseFlags(args.slice(2));

  const entry = findWorkerByName(project, worker);
  const baseBranch = flags.base ?? entry?.baseBranch ?? "main";
  const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf-8") : "";
  const mergeEpochs = workerMergeEpochs(logText, worker);
  const mergeCount = mergeEpochs.length;

  // Reconstruct the diff endpoints (explicit flags win; else reflog join).
  let fromSha = flags.from;
  let toRef = flags.to;
  if (!fromSha || !toRef) {
    if (mergeCount < 2) {
      console.error(
        `Only ${mergeCount} merge event(s) for ${worker} in the log — not a multi-phase target, `
        + `or the log was truncated. Pass --from <sha> --to <ref> to backtest explicitly.`,
      );
      return;
    }
    let reflog: ReflogEntry[];
    try { reflog = readBaseReflog(repoPath, baseBranch); }
    catch (err) {
      console.error(`Could not read ${baseBranch} reflog in ${repoPath} (${String(err).slice(0, 120)}). Pass --from/--to explicitly.`);
      return;
    }
    const firstIdx = closestIndex(reflog, mergeEpochs[0]);
    const lastIdx = closestIndex(reflog, mergeEpochs[mergeCount - 1]);
    if (firstIdx <= 0) {
      console.error(
        `Reflog for ${baseBranch} does not reach before ${worker}'s first merge (expired or rewritten). `
        + `Pass --from <sha> --to <ref> explicitly.`,
      );
      return;
    }
    fromSha = fromSha ?? reflog[firstIdx - 1].sha; // base state BEFORE the first merge
    toRef = toRef ?? reflog[lastIdx].sha;           // base state AFTER the last merge
    console.log(`Reconstructed endpoints (verify): from=${fromSha} to=${toRef} (${mergeCount} merges, base ${baseBranch})`);
  }

  const touchedFiles = getChangedFilesBetween(repoPath, fromSha, toRef);
  if (touchedFiles.length === 0) {
    console.error(`No files changed between ${fromSha}..${toRef} — endpoints likely wrong.`);
    return;
  }
  const scopedDiff = resolveHolisticDiff(repoPath, fromSha, toRef, touchedFiles);
  const rationale = getCommitLogRange(repoPath, fromSha, toRef, touchedFiles);

  // Reconstruct a synthetic entry so the backtest exercises the SAME prompt
  // builder production uses (buildHolisticFinalReviewPrompt), in shadow mode
  // (analysis-only — no worktree to edit). toRef is the reconstructed historical
  // base tip, not the live one.
  const syntheticEntry: WorkerEntry = {
    ...(entry ?? ({} as WorkerEntry)),
    name: worker,
    branchName: entry?.branchName ?? worker,
    baseBranch,
    worktreePath: repoPath,
    baseBranchSha: fromSha,
    holisticTouchedFiles: touchedFiles,
    mergeCount: mergeCount || 2,
    holisticRationale: rationale,
    holisticReviewMode: "shadow",
  };
  const prompt = buildHolisticFinalReviewPrompt(project, repoPath, baseBranch, syntheticEntry, toRef);
  if (!prompt) {
    console.error(`Could not build holistic review prompt for ${worker} (missing base SHA).`);
    return;
  }

  const tmp = process.env.TMPDIR ?? os.tmpdir();
  const promptPath = path.join(tmp, `holistic-backtest-${worker}.prompt.txt`);
  const diffPath = path.join(tmp, `holistic-backtest-${worker}.diff.txt`);
  fs.writeFileSync(promptPath, prompt);
  fs.writeFileSync(diffPath, scopedDiff);
  console.log(`\nBacktest target: ${project}/${worker}`);
  console.log(`  merges: ${mergeCount}  files: ${touchedFiles.length}  diff: ${scopedDiff.length} bytes`);
  console.log(`  prompt: ${promptPath}`);
  console.log(`  diff:   ${diffPath}`);

  if (!flags.run) {
    console.log(`\nReview the prompt + diff, or re-run with --run to pipe the prompt through claude -p (opus).`);
    return;
  }

  // --run: feed the production shadow-mode prompt to claude -p and save its
  // findings. The prompt is analysis-only (shadow), so the reviewer reports
  // rather than edits — matching the read-only intent of a backtest.
  const findingsPath = path.join(tmp, `holistic-backtest-${worker}.findings.txt`);
  console.log(`\nRunning claude -p (opus) — this may take a minute...`);
  try {
    const findings = execFileSync("claude", ["-p", "--model", "opus"], {
      cwd: repoPath, input: prompt, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
    });
    fs.writeFileSync(findingsPath, findings);
    console.log(`\nFindings: ${findingsPath}\n`);
    console.log(findings.slice(-2000));
  } catch (err) {
    console.error(`claude -p failed: ${String(err).slice(0, 200)}`);
  }
}
