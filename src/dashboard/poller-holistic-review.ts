// Holistic post-merge review dispatcher.
//
// When a multi-phase DEFAULT worker reaches `done` having merged >=2 times,
// the poller can spawn ONE holistic-review worker to review the whole-task
// cumulative diff for cross-phase coherence defects (see the holistic-review
// workflow and docs/STATUS.md). This module owns the gate, the decision trace,
// the high-water idempotency guard, and the seed the spawned worker receives.
//
// Phasing: this module is exported but UNCALLED at first (Phase 0). The two
// trigger sites — transitionToTerminal (merge-driven done) and handleDone
// (trail-off done) — wire it in Phase 1, where it evaluates the gate and emits
// the decision trace with the project in mode "off" (no spawn). The shadow
// (analyze-only) and fix (fix-and-push) spawn paths land in Phases 2 and 3 at
// the marked site below.
//
// The high-water guard is set the moment a completion is found eligible — even
// in mode "off" — so the decision fires exactly once per done-arrival on both
// trigger sites (handleDone runs per poke; without the guard the trail-off
// path would re-evaluate every poke). Marking an "off"-mode completion as
// reviewed is correct: the feature reviews completions that happen while it is
// enabled, never retroactively, and the guard re-arms (reviewedThrough <
// mergeCount) if a re-opened worker adds more phases later.
import { tryGetProject } from "../config.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "./registry.js";

// Which trigger site invoked the dispatcher. Surfaced in the decision trace so
// validation (L1) can confirm both the merge-driven and trail-off paths fire;
// a zero count for one site is otherwise unfalsifiable.
export type HolisticEntryPath = "transitionToTerminal" | "trailoff-handleDone";

export type HolisticSkipReason =
  | "ok"
  | "not-done"
  | "workflow"
  | "mergeCount<2"
  | "already-reviewed";

export interface HolisticGate {
  eligible: boolean;
  reason: HolisticSkipReason;
}

// The structural gate. Pure — no config, no mode, no side effects — so it is
// unit-testable in isolation against synthetic entries.
export function evaluateHolisticGate(entry: WorkerEntry): HolisticGate {
  if (entry.prState !== "done") return { eligible: false, reason: "not-done" };
  // Load-bearing: `=== "default"` (not `!== "holistic-review"`) excludes grow,
  // trellis, AND the holistic child in one clause. grow/trellis legitimately
  // reach mergeCount>=2 via normal merges; only this gate keeps them out.
  if ((entry.workflow ?? "default") !== "default") return { eligible: false, reason: "workflow" };
  const mergeCount = entry.mergeCount ?? 0;
  if (mergeCount < 2) return { eligible: false, reason: "mergeCount<2" };
  if ((entry.holisticReviewedThroughMergeCount ?? 0) >= mergeCount) {
    return { eligible: false, reason: "already-reviewed" };
  }
  return { eligible: true, reason: "ok" };
}

// Evaluate the gate, emit the decision trace, and (Phases 2/3) dispatch the
// holistic worker. Idempotent per done-arrival via the high-water guard.
//
// projectPath / baseBranch are consumed by the spawn path (rationale capture +
// the spawned worker's base); they are threaded now so the Phase 1 call sites
// pass them once and the Phase 2/3 spawn needs no signature change.
export function maybeDispatchHolisticReview(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  entryPath: HolisticEntryPath,
): void {
  const { eligible, reason } = evaluateHolisticGate(entry);
  const mode = tryGetProject(projectName)?.holisticReview ?? "off";
  const traceData = {
    project: projectName,
    decision: eligible ? "dispatch" : "skip",
    reason,
    entryPath,
    mergeCount: entry.mergeCount ?? 0,
    reviewedThrough: entry.holisticReviewedThroughMergeCount ?? 0,
    workflow: entry.workflow ?? "default",
    mode,
  };
  // INFO for an actionable dispatch (keeps the info stream to real firings);
  // DEBUG for skips (still queryable for L1 without firehosing the log).
  if (eligible) log.info("poller", "holistic-review gate", { worker: entry.name, data: traceData });
  else log.debug("poller", "holistic-review gate", { worker: entry.name, data: traceData });

  if (!eligible) return;

  // Set the high-water guard NOW (once per done-arrival, all modes). A failed
  // spawn downstream is a one-shot loss by design — logged, not retried.
  updateWorkerFields(projectName, entry.name, {
    holisticReviewedThroughMergeCount: entry.mergeCount ?? 0,
  });

  if (mode === "off") return; // gate evaluated for validation (L1); no spawn

  // Phase 2 (shadow / analyze-only) and Phase 3 (fix-and-push) wire the actual
  // newWorker spawn here, computing the rationale (getCommitLogRange) and the
  // scoped diff command into buildHolisticSeed. Until then the dispatch path is
  // intentionally a no-op beyond the trace + guard.
  log.info("poller", "holistic-review dispatch eligible (spawn lands in a later phase)", {
    worker: entry.name,
    data: { project: projectName, projectPath, baseBranch, mode },
  });
}

// Assemble the seed prompt the spawned holistic worker receives. Pure string
// assembly (no git, no spawn) so it is unit-testable and callable from the
// dispatch path once spawning is wired. `rationale` is the cross-phase commit
// log captured at dispatch time (see git.getCommitLogRange).
export function buildHolisticSeed(args: {
  originalName: string;
  baseBranch: string;
  baseBranchSha: string;
  mergeCount: number;
  touchedFiles: string[];
  transcriptPath?: string;
  rationale: string;
}): string {
  const fileList = args.touchedFiles.join(" ");
  const transcript = args.transcriptPath ?? "(transcript path unavailable)";
  return [
    `[holistic-review] You are a fresh worker for a ONE-TIME holistic review of a multi-phase`,
    `task worker \`${args.originalName}\` completed across ${args.mergeCount} merges into`,
    `\`${args.baseBranch}\`.`,
    ``,
    `WHY YOU EXIST — Each merge was independently reviewed, but only as a single delta against`,
    `the then-current base. NOBODY reviewed the ASSEMBLED WHOLE. Find cross-phase coherence`,
    `defects: an abstraction an early phase introduced that a later phase made obsolete; dead`,
    `code a later phase orphaned; a shared-registry/config collision "resolved" by keeping every`,
    `entry; a contract an early phase set that a later phase silently broke.`,
    ``,
    `RATIONALE — DO NOT UNDO DELIBERATE DECISIONS. Original worker \`${args.originalName}\``,
    `(transcript: ${transcript}) — read its final summary for intent. Commit history across`,
    `phases:`,
    args.rationale.trim() || "(commit log unavailable)",
    ``,
    `If a choice looks "wrong" but matches a deliberate documented decision (not ratcheting a`,
    `baseline, deliberately keeping every registry entry, a stub left for follow-up), it is OUT`,
    `OF SCOPE.`,
    ``,
    `HOW TO SEE THE ASSEMBLED DIFF (in your worktree, after bootstrap):`,
    `    git fetch origin`,
    `    git diff ${args.baseBranchSha}..origin/${args.baseBranch} -- ${fileList}`,
    ``,
    `SCOPING LIMITATION — This diff is SCOPED to files the original worker touched. A real defect`,
    `can ripple into a file it never edited (dead code orphaned elsewhere, a caller now broken);`,
    `the scoped diff won't show those. The file list is a starting point, not a fence — if your`,
    `reading implies a problem outside the list, investigate anyway.`,
    ``,
    `ACTION BAR — Only fix GENUINE cross-phase coherence defects. Do NOT re-litigate per-phase`,
    `review, apply stylistic edits, "improve" working code, touch anything the rationale marks`,
    `deliberate, or extend scope. A finding must be a concrete defect in how phases COMBINE, with`,
    `a one-line note on which phases conflict and why.`,
    ``,
    `IF COHERENT (the common outcome): change NOTHING, do NOT commit, invoke the \`done\` skill,`,
    `end your turn. Do not invent work.`,
    ``,
    `IF YOU FIND DEFECTS: fix minimally, commit naming the cross-phase defect, AND invoke \`done\``,
    `in the SAME TURN. Your branch rides the normal review + CI + merge gate.`,
    ``,
    `RECURSION SAFETY — You are a \`holistic-review\` worker; you never spawn another.`,
  ].join("\n");
}
