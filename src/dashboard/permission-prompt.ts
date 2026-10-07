// Clears a claude-code worker's `asking` once its permission dialog closes.
//
// Claude Code's PermissionRequest hook marks the worker `asking` the moment the
// dialog opens, but no hook fires when the operator approves: the next event is
// the approved tool's PostToolUse, which for a long Bash command (a test suite,
// a wait loop) lands minutes later. Until then the row read `asking` over a
// worker that was plainly running. The pane is the only witness to the answer,
// so this reads it: the dialog hides the caret, and approving it puts the caret
// back in the composer box.
//
// Two drivers share the check. The hook spawns `watchPermissionPrompt` detached
// for each permission dialog, polling every second so the row flips as soon as
// the operator answers; it gives up after WATCH_MS, and the watchdog's
// `sweepAnsweredPermissionPrompts` covers anything answered later or a watcher
// that died. Both write only when the worker is still in the same `asking`
// episode, so neither can clear a newer question.
import { readRegistry, updateWorkerFieldsIf, type WorkerRegistry } from "./registry.js";
import { findWorkerPaneId, refreshDashboard } from "./header.js";
import { capturePaneText, readPaneCursorState, type PaneCursorState } from "./tmux.js";
import { DEFAULT_HARNESS } from "./harness/core.js";
import { log } from "./log.js";

const POLL_MS = 1_000;
const WATCH_MS = 10 * 60_000;
// The watchdog reads a single sample, so it leaves fresh episodes alone: the
// PermissionRequest hook runs before Claude Code draws the dialog, and a read
// in that gap sees the composer still holding the caret.
const SWEEP_MIN_AGE_MS = 10_000;

const COMPOSER_MARKER = "❯";
const RULE = /^─+$/;

// True when the visible caret sits inside Claude Code's composer: the box whose
// first row starts with "❯" at column 0 directly under a full-width rule. A
// dialog's selection cursor is indented (" ❯ 1. Yes") or, in AskUserQuestion,
// not under a rule, and a dialog's own text field sits below the dialog's rule,
// so walking up from the caret reaches a rule before any composer row.
export function composerHasCursor(captured: string, cursor: PaneCursorState | null): boolean {
  if (!cursor?.visible) return false;
  const rows = captured.split("\n");
  for (let y = cursor.y; y > 0; y--) {
    const row = rows[y] ?? "";
    if (RULE.test(row.trim())) return false;
    if (row.startsWith(COMPOSER_MARKER) && RULE.test((rows[y - 1] ?? "").trim())) return true;
  }
  return false;
}

function dialogClosed(project: string, worker: string): boolean {
  const paneId = findWorkerPaneId(project, worker);
  if (!paneId) return false;
  return composerHasCursor(capturePaneText(paneId), readPaneCursorState(paneId));
}

function clearAsking(project: string, worker: string, askedAt: number): boolean {
  const now = Date.now();
  const applied = updateWorkerFieldsIf(project, worker, entry =>
    entry.agentStatus === "asking" && entry.lastStateChangeAt === askedAt
      ? { fields: { agentStatus: "working", lastEventAt: now, lastStateChangeAt: now }, result: true }
      : { fields: null, result: false },
  ) ?? false;
  if (applied) {
    log.info("permission", "permission dialog answered, asking -> working", {
      worker,
      data: { project, askedFor: `${Math.round((now - askedAt) / 1000)}s` },
    });
  }
  return applied;
}

function sameEpisode(project: string, worker: string, askedAt: number): boolean {
  const entry = readRegistry().workers[project]?.find(candidate => candidate.name === worker);
  return entry?.agentStatus === "asking" && entry.lastStateChangeAt === askedAt;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Two consecutive closed readings, so a read landing between the hook and the
// dialog's first frame cannot clear a prompt that is about to appear.
export async function watchPermissionPrompt(project: string, worker: string, askedAt: number): Promise<void> {
  const deadline = Date.now() + WATCH_MS;
  let closedReads = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!sameEpisode(project, worker, askedAt)) return;
    closedReads = dialogClosed(project, worker) ? closedReads + 1 : 0;
    if (closedReads >= 2) {
      if (clearAsking(project, worker, askedAt)) refreshDashboard();
      return;
    }
  }
}

// Not limited to permission episodes: AskUserQuestion and ExitPlanMode clear
// through their own PostToolUse, so a closed dialog there is already working
// by the time this runs, and the pane check holds for every dialog anyway.
export function sweepAnsweredPermissionPrompts(registry: WorkerRegistry, now: number): boolean {
  let changed = false;
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.agentStatus !== "asking" || (entry.harness ?? DEFAULT_HARNESS) !== DEFAULT_HARNESS) continue;
      const askedAt = entry.lastStateChangeAt;
      if (askedAt === undefined || now - askedAt < SWEEP_MIN_AGE_MS) continue;
      if (dialogClosed(project, entry.name) && clearAsking(project, entry.name, askedAt)) changed = true;
    }
  }
  return changed;
}
