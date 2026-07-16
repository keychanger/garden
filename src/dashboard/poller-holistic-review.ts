// Holistic post-merge review dispatcher.
//
// When a multi-phase DEFAULT worker reaches `done` having merged >=2 times,
// the poller can spawn ONE holistic-review worker to review the whole-task
// cumulative diff for cross-phase coherence defects (see the holistic-review
// workflow and docs/STATUS.md). This module owns the gate, the decision trace,
// the high-water idempotency guard, and the seed the spawned worker receives.
//
// Phasing: Phase 1 wired the two trigger sites — transitionToTerminal
// (merge-driven done) and handleDone (trail-off done) — to evaluate the gate
// and emit the decision trace (mode "off": no spawn). Phase 2 spawns a holistic
// worker for mode "shadow" | "fix": shadow writes findings to
// HOLISTIC_FINDINGS_FILE (surfaced by finalizeShadowHolistic), fix commits
// through the normal review/merge gate. Phase 3 (current) adds the reviewer
// interlock that hands the cross-phase rationale to the fix branch's reviewer.
//
// The high-water guard is set the moment a completion is found eligible — even
// in mode "off" — so the decision fires exactly once per done-arrival on both
// trigger sites (handleDone runs per poke; without the guard the trail-off
// path would re-evaluate every poke). Marking an "off"-mode completion as
// reviewed is correct: the feature reviews completions that happen while it is
// enabled, never retroactively, and the guard re-arms (reviewedThrough <
// mergeCount) if a re-opened worker adds more phases later.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SESSIONS_DIR, tryGetProject, DEFAULT_HOLISTIC_REVIEW } from "../config.js";
import { log } from "./log.js";
import { addAlert } from "./alerts.js";
import { atomicWriteFile } from "./atomic-write.js";
import {
  findWorkerByName, updateWorkerFields, getWorkers, type WorkerEntry,
} from "./registry.js";
import { getCommitLogRange, getRemoteTrackingSha } from "./git.js";
import { autoContinueGateReason } from "./poller-merge.js";
import { resolveGardenRunner } from "./runner.js";
import { shellEscape } from "./tmux.js";

// Cap on holistic-review workers in flight per project. Each is an opus worker
// loading a large cumulative diff; without a cap, N multi-phase completions in
// one window spawn N opus reviewers at once. Deferred dispatches (cap hit or
// usage gate closed) do NOT set the high-water guard, so they retry on the next
// merged/done sweep poke — no new scheduled wake-up.
const HOLISTIC_CONCURRENCY_CAP = 1;

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
  const mode = tryGetProject(projectName)?.holisticReview ?? DEFAULT_HOLISTIC_REVIEW;
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

  const setGuard = () => updateWorkerFields(projectName, entry.name, {
    holisticReviewedThroughMergeCount: entry.mergeCount ?? 0,
  });

  if (mode === "off") {
    // Mark evaluated so this completion isn't retroactively reviewed if the
    // operator later enables the feature, and so the trace fires once.
    setGuard();
    return;
  }

  // mode "shadow" | "fix" — spawn a holistic worker.
  const fromSha = entry.baseBranchSha;
  const files = entry.holisticTouchedFiles ?? [];
  if (!fromSha || files.length === 0) {
    // No reconstructable diff (a pre-Phase-0 straggler, or a task that touched
    // no files). Mark reviewed so we don't retry a completion we can't review.
    log.warn("poller", "holistic-review skipped: no diff inputs", {
      worker: entry.name,
      data: { project: projectName, hasBaseSha: Boolean(fromSha), fileCount: files.length },
    });
    setGuard();
    return;
  }

  // Defer (do NOT set the guard → retries on the next sweep poke) when the
  // concurrency cap is hit or the shared usage gate is closed.
  const inFlight = getWorkers(projectName).filter(
    (w) => w.workflow === "holistic-review"
      && w.prState !== "done" && w.prState !== "merged" && w.prState !== "failing",
  ).length;
  // Project-scoped gate: the spawned holistic worker runs on this project's
  // claudeProfile/provider env, so a usage-exempt project (separate token
  // pool) dispatches through a usage-triggered closure — the same reasoning
  // as its workers' auto-continue. An explicit `garden auto off` still defers.
  const gateReason = autoContinueGateReason(projectName);
  if (inFlight >= HOLISTIC_CONCURRENCY_CAP || gateReason) {
    log.debug("poller", "holistic-review dispatch deferred", {
      worker: entry.name,
      data: { project: projectName, inFlight, cap: HOLISTIC_CONCURRENCY_CAP, gateReason },
    });
    return;
  }

  setGuard();

  // Rationale: cross-phase commit log over the whole-task range, scoped to the
  // touched files. Seeds both the holistic worker's brief and (Phase 3) the
  // reviewer interlock on its fix branch. Computed from the project checkout,
  // which has both baseBranchSha and the current base tip in history.
  const toSha = getRemoteTrackingSha(projectPath, baseBranch) ?? `origin/${baseBranch}`;
  const rationale = getCommitLogRange(projectPath, fromSha, toSha, files);
  updateWorkerFields(projectName, entry.name, { holisticRationale: rationale });

  // Also persist the rationale to a file so the spawn subprocess can stamp it
  // onto the CHILD worker's entry — the per-branch reviewer of a fix branch
  // reads ctx.entry.holisticRationale (the deliberate-decision interlock), and
  // the child, not the original, is what gets reviewed.
  const rationaleFile = path.join(SESSIONS_DIR, `holistic-rationale-${projectName}-${entry.name}.txt`);
  try { atomicWriteFile(rationaleFile, rationale); } catch { /* best effort */ }

  const seed = buildHolisticSeed({
    originalName: entry.name,
    baseBranch,
    baseBranchSha: fromSha,
    mergeCount: entry.mergeCount ?? 2,
    touchedFiles: files,
    transcriptPath: entry.transcriptPath,
    rationale,
    mode,
  });
  const seedFile = path.join(SESSIONS_DIR, `holistic-seed-${projectName}-${entry.name}.txt`);
  try {
    atomicWriteFile(seedFile, seed);
  } catch (err) {
    log.warn("poller", "holistic-review seed write failed", {
      worker: entry.name, data: { project: projectName, error: String(err) },
    });
    return;
  }

  // Spawn via a detached `garden dashboard _spawn-holistic-worker` subprocess
  // rather than an in-process import of workers.ts. workers.ts pulls the heavy
  // create.ts/skills.ts chain, and esbuild inlines even a dynamic import into
  // the single-file hook bundle — a static or dynamic reference here would
  // bloat dist/hook.js by ~75kb. The subprocess severs that build dependency
  // (newWorker runs in the spawned CLI process). Mirrors continue.ts's
  // spawnDelayed trampoline.
  try {
    const runner = resolveGardenRunner();
    const cmd = `${runner} dashboard _spawn-holistic-worker ${shellEscape(projectName)} ${shellEscape(seedFile)} ${shellEscape(rationaleFile)} 2>/dev/null`;
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    // Launching a holistic review is routine default behavior (holisticReview
    // defaults to `fix`), so it is a log entry, not an operator alert. Only the
    // shadow-mode findings (finalizeShadowHolistic) and budget/error conditions
    // warrant an alert.
    log.info("poller", "holistic-review worker spawn dispatched", {
      worker: entry.name, data: { project: projectName, mode, mergeCount: entry.mergeCount },
    });
  } catch (err) {
    log.warn("poller", "holistic-review spawn failed", {
      worker: entry.name, data: { project: projectName, error: String(err) },
    });
  }
}

// Finalize a SHADOW holistic worker that reached quiescent `done`: surface its
// findings as a warn alert, copy them to a durable sessions path, and consume
// the worktree findings file so the next poke is a no-op (idempotency without a
// reap or an extra registry field). Called from handleDone for holistic-review
// workers. Fix-mode workers commit instead of writing findings, so they go
// through review/merge and never reach this quiescent path.
export function finalizeShadowHolistic(projectName: string, entry: WorkerEntry): void {
  const wt = entry.worktreePath;
  if (!wt) return;
  const findingsPath = path.join(wt, HOLISTIC_FINDINGS_FILE);
  let findings: string;
  try {
    findings = fs.readFileSync(findingsPath, "utf-8").trim();
  } catch {
    return; // not written yet, or already consumed
  }
  const durable = path.join(SESSIONS_DIR, `holistic-findings-${projectName}-${entry.name}.md`);
  try { atomicWriteFile(durable, findings); } catch { /* best effort */ }
  const clean = /^CLEAN\b/i.test(findings);
  addAlert({
    level: "warn",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message: clean
      ? `Holistic review CLEAN (${entry.name}): no cross-phase defects. ${durable}`
      : `Holistic review FINDINGS (${entry.name}): ${findings.slice(0, 160).replace(/\s+/g, " ")} … ${durable}`,
    dedupKey: `holistic-findings:${projectName}:${entry.name}`,
  });
  log.info("poller", "holistic-review shadow findings surfaced", {
    worker: entry.name, data: { project: projectName, clean, durable },
  });
  try { fs.unlinkSync(findingsPath); } catch { /* already gone */ }
}

// Relative path (in the holistic worker's worktree) where a shadow-mode review
// writes its findings. The poller reads it when the worker reaches `done`.
export const HOLISTIC_FINDINGS_FILE = ".holistic-findings.md";

// Assemble the seed prompt the spawned holistic worker receives. Pure string
// assembly (no git, no spawn) so it is unit-testable. `rationale` is the
// cross-phase commit log captured at dispatch time (see git.getCommitLogRange).
export function buildHolisticSeed(args: {
  originalName: string;
  baseBranch: string;
  baseBranchSha: string;
  mergeCount: number;
  touchedFiles: string[];
  transcriptPath?: string;
  rationale: string;
  // "shadow" → analyze-only, write findings to HOLISTIC_FINDINGS_FILE, never
  // commit. "fix" → fix genuine defects and commit through the normal gate.
  mode: "shadow" | "fix";
}): string {
  const fileList = args.touchedFiles.join(" ");
  const transcript = args.transcriptPath ?? "(transcript path unavailable)";
  const disposition = args.mode === "shadow"
    ? [
        `THIS IS A SHADOW (ANALYSIS-ONLY) PASS — make NO code edits and NO commits.`,
        ``,
        `IF COHERENT (the common outcome): write the single line "CLEAN — no cross-phase`,
        `defects" to \`${HOLISTIC_FINDINGS_FILE}\` in your worktree root, invoke the \`done\``,
        `skill, and end your turn. Do not invent work.`,
        ``,
        `IF YOU FIND DEFECTS: write them to \`${HOLISTIC_FINDINGS_FILE}\` in your worktree root —`,
        `one concrete cross-phase defect per entry, each naming which phases conflict and why —`,
        `then invoke \`done\` and end your turn. Do NOT edit code or commit; this is a`,
        `signal-quality measurement, not a fix.`,
      ]
    : [
        `IF COHERENT (the common outcome): change NOTHING, do NOT commit, invoke the \`done\``,
        `skill, end your turn. Do not invent work.`,
        ``,
        `IF YOU FIND DEFECTS: fix minimally, commit naming the cross-phase defect, AND invoke`,
        `\`done\` in the SAME TURN. Your branch rides the normal review + CI + merge gate.`,
      ];
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
    `ACTION BAR — Only flag GENUINE cross-phase coherence defects. Do NOT re-litigate per-phase`,
    `review, apply stylistic edits, "improve" working code, touch anything the rationale marks`,
    `deliberate, or extend scope. A finding must be a concrete defect in how phases COMBINE, with`,
    `a one-line note on which phases conflict and why.`,
    ``,
    ...disposition,
    ``,
    `RECURSION SAFETY — You are a \`holistic-review\` worker; you never spawn another.`,
  ].join("\n");
}
