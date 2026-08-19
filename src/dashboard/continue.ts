// Auto-continue prompts for workers.
//
// Two flavors:
//
// 1) Interrupt recovery — when the dashboard is killed (or a worker is
//    bounced) while agentStatus is "working", the worker has no way to
//    resume on its own. The pane-died hook records `interruptedWhileWorking`
//    on the registry entry; on resume, ensureDashboard fires a delayed
//    subprocess that sends a "continue from where you left off" prompt.
//
// 2) Post-merge auto-continue — when the poller successfully merges a
//    worker's branch into its base, finalizeMerge dispatches a continue
//    prompt so the worker keeps building on the merged base without manual
//    intervention. The worker opts out by writing the .garden-done sentinel file
//    (see `donePath` below).
//
// Living in its own file (rather than workers.ts) so create.ts and poller.ts
// can dispatch the delayed continue without forming circular imports.

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { DASHBOARD_SESSION } from "../session.js";
import { readDashState } from "./state.js";
import { findWorkerByName, updateWorkerFields, type AgentStatus } from "./registry.js";
import {
  shellEscape, getFirstPaneId, paneExists, windowExists, pasteAndSubmit,
  pressEnter, capturePaneText, capturePaneCursor, paneRunningOnlyShell,
  type PaneCursor,
} from "./tmux.js";
import { workerWindowName as workerWin } from "./window-names.js";
import { log } from "./log.js";
import { resolveGardenRunner } from "./runner.js";
import { recordContinueDispatched } from "./telemetry.js";
import { addAlert } from "./alerts.js";
import { tryGetProject } from "../config.js";

// Which garden-initiated paste this is — the `kind` on the continue.dispatched
// telemetry event. Not operator prompts: those arrive via UserPromptSubmit and
// are deliberately not recorded here.
export type ContinueKind = "interrupt" | "post-merge" | "handoff-callback" | "seed";

// The fenced [garden] prefix marks the message as system-injected so the
// worker doesn't mistake it for human direction.
const CONTINUE_PROMPT =
  "[garden] You were interrupted by a restart. Continue from where you left "
  + "off, or say so if your task was already finished.";

// A leading [garden] line pinning an autocontinue'd worker to its own branch.
// Every worker runs in a git worktree of the SHARED project repo, so sibling
// workers' branches — and their origin/<branch> tracking refs — are visible in
// `git branch -a` from this worktree. The post-merge continue prompt named no
// branch, so a worker on a multi-worker project (two workers on `lex`) rebased
// onto the OTHER worker's branch when it tried to "continue on the merged
// base". Naming the worker's own branch and base, and forbidding sibling-branch
// git operations, removes that ambiguity. Note the base operations the
// sync-failed nudge relies on (`git reset --hard origin/<base>`) stay allowed —
// only OTHER workers' branches are off-limits.
function branchIdentityLine(branch: string | undefined, base: string | undefined): string {
  const b = branch ? `\`${branch}\`` : "your own worker branch";
  const baseClause = base
    ? ` It was branched from \`${base}\`; if you need the merged mainline, use \`origin/${base}\` — never a sibling worker's branch.`
    : "";
  return (
    `[garden] You are working in your own git worktree on branch ${b}. This `
    + "project may have other active workers whose branches share this repository "
    + "and show up in `git branch -a` here — do NOT rebase onto, merge, reset to, "
    + `or check out any branch other than ${b}.${baseClause} Stay on ${b}.`
  );
}

// Interrupt-recovery prompt, branch-pinned. Built per-worker (rather than a
// const) so it can name the worker's own branch — same anti-confusion guard as
// the post-merge prompt.
function buildInterruptContinuePrompt(branch: string | undefined, base: string | undefined): string {
  return `${branchIdentityLine(branch, base)}\n\n${CONTINUE_PROMPT}`;
}

const MERGE_CONTINUE_BASE =
  "[garden] Your previous changes were reviewed and merged. Before you decide "
  + "you are finished, re-read the operator's ORIGINAL request (scroll back to "
  + "what they actually typed) and list each distinct deliverable they asked "
  + "for. The internal stages of any analysis or workflow you ran to produce "
  + "the work — research, design, implementation, a review or verification "
  + "pass — are NOT operator deliverables; finishing all of yours does not mean "
  + "the request is finished. For each deliverable, confirm it has LANDED in a "
  + "merged commit and actually does what was asked: if the change is "
  + "observable (a fix, an optimization, a feature), confirm you verified it "
  + "works, not just that you pushed code. If any deliverable has not landed or "
  + "is unverified, do that next. Only once every deliverable is accounted for "
  + "— or your only remaining uncertainty is whether to do MORE than was asked "
  + "— invoke the `done` skill (`touch .garden-done`) and end your turn. Do NOT "
  + "invent additional work, polish, refactors, cleanup, doc tweaks, or "
  + "\"while we're here\" improvements the operator did not explicitly ask "
  + "for: stopping early is strictly preferred over fabricating scope, and "
  + "the operator will redirect you if more is needed. This prompt is the "
  + "merge notification, not an instruction to find more to do.";

const MAX_LISTED_FILES = 20;

function buildMergeContinuePrompt(
  projectName: string,
  changedFiles: string[] | undefined,
  syncFailed: boolean | undefined,
  baseBranch: string | undefined,
  branchName: string | undefined,
): string {
  // Lead with the branch identity so the worker knows which branch it owns
  // before any "continue building" instruction tempts it onto a sibling's.
  const parts: string[] = [branchIdentityLine(branchName, baseBranch)];
  if (changedFiles && changedFiles.length > 0) {
    const list = changedFiles.length <= MAX_LISTED_FILES
      ? changedFiles.join(", ")
      : `${changedFiles.slice(0, MAX_LISTED_FILES).join(", ")} (and ${changedFiles.length - MAX_LISTED_FILES} more)`;
    parts.push(
      "[garden] During review, the following files were modified before your "
      + `branch was merged: ${list}. Your in-memory understanding of those `
      + "files is now stale — re-read any you plan to touch before editing.",
    );
  }
  if (syncFailed) {
    // Branch ref on origin is gone (deleted post-merge), so target the base
    // branch — its tip equals the merged commit.
    const base = baseBranch ?? "<base-branch>";
    parts.push(
      "[garden] I could not auto-sync your worktree to the merged tip "
      + "(uncommitted changes or git error). Your worker branch was already "
      + "deleted from origin after merge, so commit or stash any local edits "
      + `and run \`git fetch origin ${base} && git reset --hard origin/${base}\` `
      + "before resuming work.",
    );
  }
  const project = tryGetProject(projectName);
  if (project?.postMerge) {
    parts.push(
      `[garden] The project's postMerge hook already ran after merge: \`${project.postMerge}\`. `
      + "Do not tell the operator to pull, restart, or run any post-merge steps — "
      + "it is already done.",
    );
  }
  parts.push(MERGE_CONTINUE_BASE);
  return parts.join("\n\n");
}

// Sentinel suppressing post-merge auto-continue. Lives at the worktree root —
// the only path writable by both sandbox layers and reconstructible from the
// registry. See DESIGN.md "Auto-Continue Across the Merge Boundary" for why.
export function donePath(worktreePath: string): string {
  return path.join(worktreePath, ".garden-done");
}

export function isDoneSet(worktreePath: string | undefined): boolean {
  if (!worktreePath) return false;
  return fs.existsSync(donePath(worktreePath));
}

export function clearDoneSentinel(worktreePath: string | undefined): void {
  if (!worktreePath) return;
  try { fs.unlinkSync(donePath(worktreePath)); } catch { /* not present */ }
}

// Workflow handlers (trellis ALIGNED path) write the sentinel on the
// worker's behalf so finalizeMerge picks `done` instead of `merged`. The
// file is empty — its presence is the signal. See WORKFLOWS.md "Equilibrium
// and termination" / "Aligned" disposition.
export function setDoneSentinel(worktreePath: string | undefined): void {
  if (!worktreePath) return;
  try { fs.writeFileSync(donePath(worktreePath), ""); } catch { /* worktree gone */ }
}

// Sentinel suppressing auto-continue while a worker is mid-task but waiting on
// operator input (the human gate shared with the botanist/plan workflows). Like
// .garden-done it lives at the worktree root and its mere presence is the
// signal, but the semantics differ: .garden-done means "finished, do not
// continue me"; .garden-awaiting-input means "paused for the operator, resume
// on their next prompt". The worker writes it (skill-driven) and the next
// UserPromptSubmit clears it. Auto-continue skips on either sentinel.
export function awaitingInputPath(worktreePath: string): string {
  return path.join(worktreePath, ".garden-awaiting-input");
}

export function isAwaitingInput(worktreePath: string | undefined): boolean {
  if (!worktreePath) return false;
  return fs.existsSync(awaitingInputPath(worktreePath));
}

export function clearAwaitingInput(worktreePath: string | undefined): void {
  if (!worktreePath) return;
  try { fs.unlinkSync(awaitingInputPath(worktreePath)); } catch { /* not present */ }
}

function resolveWorkerPaneId(project: string, worker: string): string | null {
  const windowName = workerWin(project, worker);
  const state = readDashState();
  if (state.activeWindowName === windowName && state.activePaneId
      && paneExists(state.activePaneId)) {
    return state.activePaneId;
  }
  if (windowExists(windowName)) {
    return getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  }
  return null;
}

// Claude Code's TUI input prompt glyph (U+276F). The operator's typed text
// appears right after the marker — but the box is NOT blank when empty: Claude
// Code renders dimmed ghost/placeholder/autosuggest text into an empty box, and
// capture-pane strips the dimming, so the bare remainder after the marker can't
// distinguish a real draft from a suggestion. The caret can: it sits at the end
// of typed text, with any suggestion rendered to its right. So the draft is the
// span between the marker and the cursor column (see extractOperatorDraft).
const PROMPT_MARKER = "❯";

// Backoff for re-arming an auto-continue prompt that was deferred because the
// operator had an unsent draft in the box. 12s spacing × 15 attempts ≈ 3min of
// patience; past that we stop (the operator is clearly driving the worker by
// hand, and the merge path's gate-reopen sweep remains a long-tail backstop).
const DRAFT_BACKOFF_MS = 12_000;
const MAX_DRAFT_RETRIES = 15;

// Pull the operator's unsent draft out of a captured Claude pane. The live
// input line is the bottom-most line whose only glyphs before the prompt marker
// are whitespace (the status/mode lines sit below it, agent output above), so we
// scan upward and take the first match.
//
// `cursor` (0-based col,row from the same pane) excludes the dimmed
// ghost/placeholder text Claude Code paints into an empty box: the caret marks
// the end of typed text, so only the span between the marker and the cursor
// column is the operator's draft — anything to the caret's right is a suggestion.
// A caret on a row below the marker means the draft wrapped (so the first row
// holds text); a caret above it is not on the input line. When the cursor is
// unknown (null — pane unreachable), fall back to the whole post-marker
// remainder. Returns "" when the box is empty or no prompt line is visible.
export function extractOperatorDraft(captured: string, cursor: PaneCursor | null): string {
  const lines = captured.split("\n");
  let markerRow = -1;
  let markerCol = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const col = lines[i].indexOf(PROMPT_MARKER);
    if (col !== -1 && lines[i].slice(0, col).trim() === "") {
      markerRow = i;
      markerCol = col;
      break;
    }
  }
  if (markerRow === -1) return "";

  const inputStart = markerCol + PROMPT_MARKER.length;
  if (!cursor) return lines[markerRow].slice(inputStart).trim();
  if (cursor.y < markerRow) return "";
  if (cursor.y > markerRow) return lines[markerRow].slice(inputStart).trim();
  return lines[markerRow].slice(inputStart, cursor.x).trim();
}

export function paneHasOperatorDraft(paneId: string): boolean {
  return extractOperatorDraft(capturePaneText(paneId), capturePaneCursor(paneId)).length > 0;
}

// Visible heads a garden-initiated paste can render as in the input box.
// Every continuation prompt leads with a literal "[garden]" line and handoff
// seed briefings with "[handoff from …]"; Claude Code collapses a multi-line
// paste (which all of these are) to the "[Pasted text #N +L lines]"
// placeholder, so that is the common stuck rendering.
const GARDEN_PASTE_SIGNATURES = ["[garden]", "[handoff", "[Pasted text"];

// True when the draft in the box is garden's own earlier paste whose Enter
// taps were eaten, rather than an operator's compose. Two conditions, both
// load-bearing:
//  - entry.continueSentAt: garden pasted, and no prompt of ANY kind has
//    landed since (the UserPromptSubmit hook clears the field) — so the paste
//    demonstrably never submitted and its text is still in the box.
//  - a garden-paste signature on the draft's visible head: an operator draft
//    typed after clearing our stuck text does not match, and keeps the full
//    defer treatment.
// Without this, the draft guard starved on garden's own stuck paste — every
// retry re-captured the same unsent text, read it as an operator draft, and
// deferred, which is how bead-intake workers missed their seeded `bd close`
// (board's delegation-loop acceptance run, 2026-08-14). The residual false
// positive — the operator clears our paste, then pastes multi-line content of
// their own without submitting, matching "[Pasted text" — requires them to
// discard a visible garden prompt mid-window and is accepted.
export function isOwnStuckPaste(
  entry: { continueSentAt?: number },
  draft: string,
): boolean {
  if (!entry.continueSentAt) return false;
  return GARDEN_PASTE_SIGNATURES.some((sig) => draft.startsWith(sig));
}

// The loop workflows' variant of the draft gate (see loop.ts): a draft blocks
// the cold respawn only when it is a genuine operator compose. Garden's own
// stuck paste must not block — the respawn discards it and re-seeds, which is
// the loop-shaped recovery.
export function paneHasBlockingOperatorDraft(
  paneId: string,
  entry: { continueSentAt?: number },
): boolean {
  const draft = extractOperatorDraft(capturePaneText(paneId), capturePaneCursor(paneId));
  if (draft.length === 0) return false;
  return !isOwnStuckPaste(entry, draft);
}

// True when the worker's pane currently holds an unsent operator draft. Used by
// the backoff re-arm to tell a draft-deferred skip apart from the other skip
// reasons (no pane, agent mid-turn) that should not retry on this loop.
export function workerHasOperatorDraft(projectName: string, workerName: string): boolean {
  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) return false;
  return paneHasOperatorDraft(paneId);
}

// Re-arm a deferred auto-continue after DRAFT_BACKOFF_MS when — and only when —
// the worker still has an unsent draft. Called by the _continue-worker* dispatch
// handlers after a skipped delivery: a skip caused by the agentStatus gate (box
// empty) leaves no draft, so this no-ops and the existing *-if-stuck retry leg
// owns that case. Stops after MAX_DRAFT_RETRIES so a draft left sitting forever
// can't spawn an unbounded chain of detached children.
export function rearmContinueIfDrafting(
  sub: string,
  projectName: string,
  workerName: string,
  attempt: number,
): void {
  if (!workerHasOperatorDraft(projectName, workerName)) return;
  if (attempt >= MAX_DRAFT_RETRIES) {
    log.warn("workers", "continue backoff exhausted, operator still drafting", {
      worker: workerName,
      data: { project: projectName, attempts: attempt },
    });
    return;
  }
  log.info("workers", "continue deferred, operator drafting; re-arming", {
    worker: workerName,
    data: { project: projectName, attempt, backoffMs: DRAFT_BACKOFF_MS },
  });
  spawnDelayed(resolveGardenRunner(), DRAFT_BACKOFF_MS, sub, projectName, workerName,
    "--attempt", String(attempt + 1));
}

// Build and dispatch a handoff-callback prompt at the parent pane of a worker
// that just reached a terminal prState (merged/done/failing). Best-effort:
// silently no-ops if the parent has been removed, has no live pane, or is
// currently mid-turn (continueWorker's agentStatus gate). One-shot per child:
// the caller is expected to have checked + set handoffCallbackFiredAt under
// the registry lock to prevent re-fires from replayed terminal transitions.
//
// The prompt is informational. We're not asking the parent to do anything
// specific — just letting it know the worker it spawned has settled. If the
// parent was waiting on this handoff to proceed, the cue is here. If the
// parent has already moved on, the inline message tells it so.
export function notifyHandoffCallback(opts: {
  childProject: string;
  childWorker: string;
  childBranch: string | undefined;
  terminalState: "merged" | "done" | "failing";
  parentProject: string;
  parentWorker: string;
  replyNote: string | undefined;
}): void {
  const stateLabel
    = opts.terminalState === "merged" ? "merged"
      : opts.terminalState === "done" ? "done (no further work expected)"
      : "failing (needs operator attention)";
  const lines: string[] = [
    `[garden] Handoff callback: ${opts.childProject}/${opts.childWorker} reached terminal state \`${stateLabel}\`.`,
  ];
  if (opts.childBranch) lines.push(`  branch: ${opts.childBranch}`);
  if (opts.replyNote && opts.replyNote.trim()) {
    lines.push("", `Reply from ${opts.childWorker}:`, opts.replyNote.trim());
  }
  lines.push(
    "",
    "This is an informational nudge — the child worker you handed off to has "
    + "settled. If you were waiting on it to proceed, take the next step. If "
    + "you have already finished and moved on, you can ignore this and end "
    + "your turn.",
  );
  continueWorker(opts.parentProject, opts.parentWorker, lines.join("\n"), "handoff-callback");
}

// Send a continue prompt to a worker pane. Called via the _continue-worker
// internal command after a short delay so Claude --resume has time to take
// over the pane's stdin. Skips if the worker has already started working
// (operator typed something first) to avoid stomping on a real prompt.
// Returns true when the prompt was actually pasted, false when it was skipped
// (entry/pane missing, worker mid-turn, or send-keys threw). Callers that need
// to know whether delivery happened — the post-merge retry leg, and the
// changed-files preamble cleanup — branch on this; the interrupt path ignores it.
export function continueWorker(
  projectName: string,
  workerName: string,
  message?: string,
  kind: ContinueKind = "interrupt",
): boolean {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return false;
  // Interrupt-recovery callers pass no message; build a branch-pinned default
  // from the entry so the prompt names the worker's own branch. Explicit
  // messages (post-merge, handoff callback, seed) already carry their own text.
  const text = message ?? buildInterruptContinuePrompt(entry.branchName ?? workerName, entry.baseBranch);
  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) {
    log.warn("workers", "continue skipped, no pane", {
      worker: workerName,
      data: { project: projectName },
    });
    return false;
  }
  if (entry.agentStatus === "working" || entry.agentStatus === "asking") {
    log.info("workers", "continue skipped, worker already active", {
      worker: workerName,
      data: { project: projectName, agentStatus: entry.agentStatus },
    });
    updateWorkerFields(projectName, workerName, { interruptedWhileWorking: undefined });
    return false;
  }
  // The operator deliberately held this worker (garden hold / ⌥e → paused) and
  // is waiting to redirect it themselves. Auto-resuming here — most reachably a
  // post-merge continue on a worker held while in `merged` — would defeat the
  // hold. Leave the prompt owed (don't clear interruptedWhileWorking): the
  // operator's own redirect (UserPromptSubmit → working) clears paused and is
  // the resume.
  if (entry.agentStatus === "paused") {
    log.info("workers", "continue skipped, worker held by operator", {
      worker: workerName,
      data: { project: projectName },
    });
    return false;
  }
  // The worker's Claude has exited and the pane is now a bare shell. A clean
  // exit `exec $SHELL`s the launch wrapper WITHOUT firing pane-died, so
  // agentStatus can still read `idle` while the pane is an interactive shell.
  // Pasting the continue prompt — which carries backticked git commands
  // (`git reset --hard origin/<base>`) — would execute it in that shell. Skip:
  // reviving an exited worker is `garden bounce` territory. Leave
  // interruptedWhileWorking set (like the draft skip below) so the prompt stays
  // owed for the bounce / gate-reopen replay.
  if (paneRunningOnlyShell(paneId)) {
    log.info("workers", "continue skipped, pane is a bare shell (agent exited)", {
      worker: workerName,
      data: { project: projectName },
    });
    return false;
  }
  const draft = extractOperatorDraft(capturePaneText(paneId), capturePaneCursor(paneId));
  if (draft.length > 0) {
    // Garden's own earlier paste, stuck unsubmitted (Enter eaten). The message
    // is already in the box — re-pasting would double it, and deferring would
    // starve forever, since a stuck paste never clears itself. Press Enter to
    // submit it. No telemetry: the original paste recorded its dispatch, and
    // this is that same delivery finally landing. continueSentAt stays set
    // until the prompt hook confirms a landed prompt, so a replay retries the
    // Enter if this one is eaten too.
    if (isOwnStuckPaste(entry, draft)) {
      pressEnter(paneId);
      updateWorkerFields(projectName, workerName, { interruptedWhileWorking: undefined });
      log.info("workers", "continue re-submitted stuck garden paste", {
        worker: workerName,
        data: { project: projectName, draftHead: draft.slice(0, 40) },
      });
      return true;
    }
    // The operator is mid-compose in this pane — pasting now would concatenate
    // garden's prompt onto their draft and submit the mangled result. Skip; the
    // dispatch handler's backoff re-arm retries once the box is clear. Leave
    // interruptedWhileWorking set (unlike the active gate above) so the retry
    // still knows there is a prompt owed.
    log.info("workers", "continue skipped, operator has unsent draft", {
      worker: workerName,
      data: { project: projectName },
    });
    return false;
  }
  try {
    pasteAndSubmit(paneId, text);
  } catch (err) {
    log.warn("workers", "continue send-keys failed", {
      worker: workerName,
      data: { project: projectName, error: String(err) },
    });
    return false;
  }
  updateWorkerFields(projectName, workerName, {
    interruptedWhileWorking: undefined,
    continueSentAt: Date.now(),
  });
  log.info("workers", "continue sent", {
    worker: workerName,
    data: { project: projectName },
  });
  // Ledger the garden-initiated paste at the single success point (after
  // pasteAndSubmit landed) so the autonomy read can subtract garden's prompts
  // from the operator's. Only real deliveries count — the skip cases above
  // returned false without pasting.
  recordContinueDispatched(projectName, workerName, entry.createdAt, entry.workflow ?? "default", kind);
  return true;
}

// Retry leg of dispatchDelayedContinue. Only re-pastes when the worker is
// still parked at the cold-start "ready" state — meaning the first paste
// never reached Claude's input handler. If Claude has since moved to
// working/asking (paste landed, response in flight) or idle (paste landed,
// response already finished), we leave it alone. continueWorker's gate
// covers working/asking; this wrapper adds the idle exclusion the retry
// leg needs.
export function continueWorkerIfStuck(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return;
  if (entry.agentStatus !== "ready") {
    log.info("workers", "continue retry skipped, status moved", {
      worker: workerName,
      data: { project: projectName, agentStatus: entry.agentStatus },
    });
    return;
  }
  log.info("workers", "continue retry firing, worker still cold-start ready", {
    worker: workerName,
    data: { project: projectName },
  });
  continueWorker(projectName, workerName);
}

// Send the post-merge continuation prompt. Same machinery as continueWorker
// but with a merge-flavored message that lists files modified during review
// (so Claude re-reads them) and warns when the post-merge worktree sync was
// skipped. Reads the transient pendingContinue* fields written by
// finalizeMerge and clears them after sending. Returns whether the prompt was
// delivered so the dispatch handler can re-arm a draft-deferred skip.
export function continueWorkerAfterMerge(projectName: string, workerName: string): boolean {
  const entry = findWorkerByName(projectName, workerName);
  const message = buildMergeContinuePrompt(
    projectName,
    entry?.pendingContinueChangedFiles,
    entry?.pendingContinueSyncFailed,
    entry?.baseBranch,
    entry?.branchName ?? workerName,
  );
  const delivered = continueWorker(projectName, workerName, message, "post-merge");
  // Clear the transient stale-files / sync-failed context only once the prompt
  // actually landed. If the first attempt was skipped (worker still mid-turn),
  // leave them set so the retry leg re-emits the same enriched prompt.
  if (delivered && (entry?.pendingContinueChangedFiles || entry?.pendingContinueSyncFailed)) {
    updateWorkerFields(projectName, workerName, {
      pendingContinueChangedFiles: undefined,
      pendingContinueSyncFailed: undefined,
    });
  }
  return delivered;
}

// Retry leg of dispatchDelayedAutoContinue, mirroring continueWorkerIfStuck for
// the interrupt path. The post-merge prompt is delivered once at +5s; if the
// worker read as `working`/`asking` at that instant (still settling, or
// babysitting a long-running turn), continueWorker skipped the paste and the
// prompt was lost with no recovery. We re-fire only when it demonstrably never
// landed: prState is still `merged`. A delivered prompt fires UserPromptSubmit,
// which clears `merged` (hooks/default.ts) — so any other prState means it got
// through and we no-op rather than double-prompt. continueWorkerAfterMerge's
// own agentStatus gate covers the case where the worker is mid-turn again.
export function continueWorkerAfterMergeIfStuck(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return;
  if (entry.prState !== "merged") {
    log.info("workers", "merge-continue retry skipped, prState moved", {
      worker: workerName,
      data: { project: projectName, prState: entry.prState },
    });
    return;
  }
  log.info("workers", "merge-continue retry firing, prompt never landed", {
    worker: workerName,
    data: { project: projectName },
  });
  continueWorkerAfterMerge(projectName, workerName);
}

// Fire-and-forget detached subprocess that defers a few seconds, then invokes
// the _continue-worker internal command. The delay lets `claude --resume` take
// over the pane's stdin before we send keys; without it, keystrokes get eaten
// during Claude's TUI init.
//
// 6s primary + 16s retry: on dashboard rebuild, ~10 workers run `claude
// --resume` concurrently and TUI bootstrap can outlast the SessionStart hook
// — under that load, a 3s paste landed before Claude's input handler bound,
// silently dropping the prompt. The retry fires _continue-worker-if-stuck,
// which re-pastes only if the worker is still at "ready" (cold-start state) —
// meaning the first paste never registered. If status has advanced to
// working/asking/idle, the prompt got through and the retry no-ops.
//
// Two independent detached children, each holding its own delay timer in
// Node via --delay-ms; previously a single `sh -c "sleep N && garden ..."`
// shell wrapper drove the delay. The shell trampoline stays — it's the
// canonical way to invoke a multi-token gardenRunner string ("node /path/cli.js")
// — but the `sleep N &&` prefix is gone, so the shell exec's straight into
// garden and exits. No standalone `sleep` process; no readerless FIFO write
// to block on (the leak that motivated the switch).
function spawnDelayed(gardenRunner: string, delayMs: number, sub: string, ...positional: string[]): void {
  const escaped = positional.map(shellEscape).join(" ");
  const cmd = `${gardenRunner} dashboard ${sub} --delay-ms ${delayMs} ${escaped} 2>/dev/null`;
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* best effort — operator can re-prompt manually */ }
}

export function dispatchDelayedContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  spawnDelayed(gardenRunner, 6000, "_continue-worker", projectName, workerName);
  spawnDelayed(gardenRunner, 16000, "_continue-worker-if-stuck", projectName, workerName);
}

// Post-merge variant. Slightly longer delay because the merge path force-pushes
// the worker's branch and runs postMerge before this fires; we want the worker
// pane to be unambiguously idle (Stop hook returned, no Claude UI redraw in
// progress) before sending keys. 5s primary + 16s retry mirrors the interrupt
// path: a worker still mid-turn at the 5s mark (e.g. babysitting a long
// response) would otherwise drop the merge prompt permanently. The retry
// (_continue-worker-after-merge-if-stuck) only re-fires when prState is still
// `merged` — proof the prompt never landed — so it never double-prompts.
export function dispatchDelayedAutoContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  spawnDelayed(gardenRunner, 5000, "_continue-worker-after-merge", projectName, workerName);
  spawnDelayed(gardenRunner, 16000, "_continue-worker-after-merge-if-stuck", projectName, workerName);
}

// Handoff seed variant. Reads the seed prompt from a file (kept off argv to
// support multi-line briefings) and sends it as the new worker's first user
// prompt. 6s delay covers worktree bootstrap (git fetch + worktree add +
// claude TUI init) — same machinery as auto-continue, just longer because the
// new worker is starting from cold.
export function dispatchDelayedSeed(
  gardenRunner: string,
  projectName: string,
  workerName: string,
  messageFile: string,
): void {
  spawnDelayed(gardenRunner, 6000, "_seed-worker", projectName, workerName, messageFile);
}

// Send a one-shot seed prompt read from a file.
//
// A seed is the one prompt a worker cannot recover from losing. An interrupt
// or post-merge continue has a retry leg, and failing that an operator looking
// at a worker that is visibly mid-task; a lost seed leaves a live worker parked
// at an empty prompt with no task at all, which reads as "the workers didn't
// start" (observed three times on 2026-08-19, including on the launch of the
// worker that fixed this).
//
// So seeding is verified rather than fire-and-forget. tmux load-buffer succeeds
// whether or not the TUI was accepting input, so the paste itself proves
// nothing. The ground truth is already in the registry: continueWorker stamps
// `continueSentAt` when it pastes, and the UserPromptSubmit hook is the only
// writer that clears it (hooks/default.ts onPromptSubmitted). A stamp that
// changes after our send therefore means a prompt actually registered as a user
// turn in the session — the confirmation the send path cannot give us.
//
// Three phases: wait out the cold boot, paste, then confirm — retrying the
// paste on no confirmation and alerting (keeping the seed file) if it never
// lands. Retries are safe by construction: continueWorker skips a worker that
// is already mid-turn, and routes a paste still sitting unsent in the box
// through pressEnter (isOwnStuckPaste) instead of pasting it twice.

const SEED_READY_POLL_MS = 2_000;
// Cold boot is git fetch + worktree add + npm install + TUI init. Raised from
// 90s: the old cap was short enough that a slow boot expired it routinely, and
// expiry meant pasting into a still-loading TUI, which is how the seed was lost.
const SEED_READY_TIMEOUT_MS = 180_000;
const SEED_CONFIRM_POLL_MS = 2_000;
// Generous enough to cover a slow UserPromptSubmit hook write on a loaded
// machine, short enough that three attempts still fit inside the deadline.
const SEED_CONFIRM_WINDOW_MS = 45_000;
const SEED_RETRY_BACKOFF_MS = 5_000;
// A skip is a transient state the worker leaves on its own (mid-turn, operator
// drafting, pane not up yet), so it re-polls rather than burning an attempt.
const SEED_SKIP_RETRY_MS = 5_000;
const SEED_MAX_ATTEMPTS = 3;
// Overall bound on the detached seed process, covering the skip loop that
// deliberately does not consume attempts.
const SEED_DELIVERY_DEADLINE_MS = 300_000;

/** Whether a sent seed has registered as a user turn yet. Pure, so the
 *  confirmation rule is testable without a live TUI. Called only after
 *  continueWorker reported a real send, which is load-bearing for the
 *  agentStatus arm below. */
export function classifySeedDelivery(
  entry: { agentStatus?: AgentStatus; continueSentAt?: number } | undefined,
  sentStamp: number | undefined,
): "worker-gone" | "confirmed" | "pending" {
  if (!entry) return "worker-gone";
  // The prompt hook cleared the stamp we sent under (or a later paste replaced
  // it) — a prompt landed.
  if (sentStamp !== undefined && entry.continueSentAt !== sentStamp) return "confirmed";
  // Same hook pipeline, corroborating: the worker is visibly running a turn.
  // Not a stale-status false positive — continueWorker refuses to send to a
  // working/asking worker, so this state is necessarily new since our send.
  // Also covers a send whose continueSentAt write we failed to read back.
  if (entry.agentStatus === "working" || entry.agentStatus === "asking") return "confirmed";
  return "pending";
}

export function seedWorker(
  projectName: string,
  workerName: string,
  messageFile: string,
): void {
  let message: string;
  try {
    message = fs.readFileSync(messageFile, "utf8");
  } catch (err) {
    log.warn("workers", "seed failed to read message file", {
      worker: workerName,
      data: { project: projectName, file: messageFile, error: String(err) },
    });
    return;
  }

  // Seeds route through tmux load-buffer (see pasteAndSubmit); record size
  // so operators tracing a slow / missed seed can correlate with the buffer
  // path instead of guessing.
  log.info("workers", "seed dispatching", {
    worker: workerName,
    data: { project: projectName, bytes: Buffer.byteLength(message, "utf8") },
  });

  const cleanup = (): void => {
    try { fs.unlinkSync(messageFile); } catch { /* already gone */ }
  };

  const abortWorkerGone = (): void => {
    log.warn("workers", "seed skipped, worker missing", {
      worker: workerName,
      data: { project: projectName },
    });
    cleanup();
  };

  // Terminal failure. Deliberately keeps the seed file: it holds the only copy
  // of the briefing, so naming its path gives the operator (or a bounce) a way
  // to re-deliver. Never silent — an idle worker with no task is exactly the
  // symptom this whole path exists to prevent.
  const giveUp = (reason: string, attempts: number): void => {
    log.error("workers", "seed delivery failed", {
      worker: workerName,
      data: { project: projectName, reason, attempts, seedFile: messageFile },
    });
    addAlert({
      level: "error",
      source: "workers",
      project: projectName,
      worker: workerName,
      message: `Seed prompt never registered as a user turn (${reason}) — the worker is live but has no task. `
        + `Re-deliver: garden dashboard _seed-worker ${projectName} ${workerName} ${messageFile}`,
      dedupKey: `seed-lost:${projectName}:${workerName}:${messageFile}`,
    });
  };

  const startedAt = Date.now();
  const readyDeadline = startedAt + SEED_READY_TIMEOUT_MS;
  const deliveryDeadline = startedAt + SEED_DELIVERY_DEADLINE_MS;
  let attempts = 0;

  // Phase 3 — confirm the paste became a user turn, else retry the paste.
  const verify = (sentStamp: number | undefined, confirmDeadline: number): void => {
    const verdict = classifySeedDelivery(findWorkerByName(projectName, workerName), sentStamp);
    if (verdict === "worker-gone") {
      abortWorkerGone();
      return;
    }
    if (verdict === "confirmed") {
      log.info("workers", "seed confirmed", {
        worker: workerName,
        data: { project: projectName, attempts },
      });
      cleanup();
      return;
    }
    if (Date.now() >= confirmDeadline) {
      if (attempts >= SEED_MAX_ATTEMPTS) {
        giveUp(`no user turn after ${attempts} sends`, attempts);
        return;
      }
      log.warn("workers", "seed unconfirmed, re-sending", {
        worker: workerName,
        data: { project: projectName, attempts },
      });
      setTimeout(send, SEED_RETRY_BACKOFF_MS);
      return;
    }
    setTimeout(() => verify(sentStamp, confirmDeadline), SEED_CONFIRM_POLL_MS);
  };

  // Phase 2 — paste.
  const send = (): void => {
    if (Date.now() >= deliveryDeadline) {
      giveUp("delivery deadline elapsed", attempts);
      return;
    }
    const delivered = continueWorker(projectName, workerName, message, "seed");
    if (!delivered) {
      // continueWorker declined: no pane, a bare shell, the worker mid-turn, or
      // an operator draft in the box. All transient, so re-poll without
      // consuming an attempt; the delivery deadline is the bound. (A seed whose
      // own stuck paste does not match a garden signature lands here too — it
      // reads as an operator draft, and the deadline turns it into a loud
      // giveUp rather than a silent idle worker.)
      if (!findWorkerByName(projectName, workerName)) {
        abortWorkerGone();
        return;
      }
      setTimeout(send, SEED_SKIP_RETRY_MS);
      return;
    }
    attempts += 1;
    const sentStamp = findWorkerByName(projectName, workerName)?.continueSentAt;
    verify(sentStamp, Date.now() + SEED_CONFIRM_WINDOW_MS);
  };

  // Phase 1 — wait out the cold boot.
  const waitForReady = (): void => {
    const entry = findWorkerByName(projectName, workerName);
    if (!entry) {
      abortWorkerGone();
      return;
    }
    if (entry.agentStatus !== "loading") {
      send();
      return;
    }
    if (Date.now() >= readyDeadline) {
      // Sending into a still-"loading" TUI is how the seed got swallowed. We
      // still send rather than wait forever — the status itself may be stale,
      // since the session-start hook that clears "loading" can be the thing
      // that was lost — but the send is now verified, so a swallowed paste is
      // retried instead of lost.
      log.warn("workers", "seed ready-wait timed out, sending unconfirmed-ready", {
        worker: workerName,
        data: { project: projectName, agentStatus: entry.agentStatus },
      });
      send();
      return;
    }
    setTimeout(waitForReady, SEED_READY_POLL_MS);
  };

  waitForReady();
}
