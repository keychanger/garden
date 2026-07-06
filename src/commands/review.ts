// `garden review [<worker>]` — show a worker's most recent review: the verdict,
// the diff between the pre-review tip and the reviewed tip, and the review body.
// The record is captured at verdict dispatch and persisted on the entry
// (LastReviewData), so it survives cleanContextFiles and the merge reset — the
// operator can see what the reviewer decided without digging through logs. With
// no argument it resolves the dashboard's focused worker (`.`); a name/prefix
// also works.
//
// The diff is the review-window delta (preReviewSha..tipSha): the reviewer's own
// edits when the base branch held still, but it also captures base advancement
// if the reviewer rebased onto a sibling merge mid-review — so it is labelled
// "changes during review", not "reviewer changes", to stay honest in that case.
import { output, isTTY } from "../output.js";
import { resolveWorkerArg } from "./resolve-worker.js";
import { getDiffStat } from "../dashboard/git.js";
import type { LastReviewData } from "../dashboard/registry.js";

interface ReviewOutput {
  project: string;
  worker: string;
  review: LastReviewData | null;
  diffStat?: string;
}

export async function review(args: string[]): Promise<void> {
  const { project, worker, entry } = resolveWorkerArg(args[0] ?? ".");
  const last = entry.lastReview ?? null;

  // The review-window diff (preReviewSha..tipSha). Empty when nothing changed
  // during review (a CLEAN verdict with no reviewer rebase), so only compute
  // when the SHAs actually differ and the worktree is still on disk.
  let diffStat: string | undefined;
  if (last?.preReviewSha && last.tipSha && last.preReviewSha !== last.tipSha && entry.worktreePath) {
    const stat = getDiffStat(entry.worktreePath, last.preReviewSha, last.tipSha);
    if (stat) diffStat = stat;
  }

  if (!isTTY) {
    output({ project, worker, review: last, diffStat } satisfies ReviewOutput);
    return;
  }

  console.log("");
  console.log(`  \x1b[1m${project}/${worker}\x1b[0m  last review`);
  console.log("");
  if (!last) {
    console.log("    No review recorded yet.");
    console.log("");
    return;
  }

  console.log(`    verdict   ${colorVerdict(last.verdict)}  \x1b[2m${new Date(last.at).toISOString()}\x1b[0m`);
  console.log(`    checks    ${checksLine(last.verdict)}`);

  if (last.preReviewSha && last.tipSha) {
    const range = `${last.preReviewSha.slice(0, 7)}..${last.tipSha.slice(0, 7)}`;
    if (diffStat) {
      console.log("");
      console.log(`    changes during review \x1b[2m(${range})\x1b[0m:`);
      for (const line of diffStat.split("\n")) console.log(`      ${line}`);
    } else {
      console.log(`    changes during review  \x1b[2mnone (${range})\x1b[0m`);
    }
  }

  if (last.body.trim()) {
    console.log("");
    console.log("    review:");
    for (const line of last.body.trim().split("\n")) console.log(`      ${line}`);
  }
  console.log("");
}

function colorVerdict(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v === "clean" || v === "aligned") return `\x1b[1;32m${verdict}\x1b[0m`;
  if (v === "fixed" || v === "drift") return `\x1b[1;33m${verdict}\x1b[0m`;
  if (v === "failed" || v === "flagged") return `\x1b[1;31m${verdict}\x1b[0m`;
  return verdict;
}

// Best-effort translation of the workflow verdict into a universal checks
// signal. A verdict that reached merge (clean/fixed/aligned/drift) means the
// reviewer ran the project's checks command and it passed; failed/flagged means
// it did not. Unknown verdicts fall back to the raw string.
function checksLine(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v === "clean" || v === "fixed" || v === "aligned" || v === "drift") {
    return "\x1b[32mpassed\x1b[0m \x1b[2m(reviewer ran the project checks)\x1b[0m";
  }
  if (v === "failed" || v === "flagged") return "\x1b[31mnot passing\x1b[0m";
  return `\x1b[2m${verdict}\x1b[0m`;
}
