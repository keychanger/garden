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
import { findWorkerByName, updateWorkerFields } from "./registry.js";
import {
  shellEscape, getFirstPaneId, paneExists, windowExists, pasteAndSubmit,
} from "./tmux.js";
import { workerWindowName as workerWin } from "./window-names.js";
import { log } from "./log.js";
import { tryGetProject } from "../config.js";

// The fenced [garden] prefix marks the message as system-injected so the
// worker doesn't mistake it for human direction.
const CONTINUE_PROMPT =
  "[garden] You were interrupted by a restart. Continue from where you left "
  + "off, or say so if your task was already finished.";

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
): string {
  const parts: string[] = [];
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
  continueWorker(opts.parentProject, opts.parentWorker, lines.join("\n"));
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
  message: string = CONTINUE_PROMPT,
): boolean {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return false;
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
  try {
    pasteAndSubmit(paneId, message);
  } catch (err) {
    log.warn("workers", "continue send-keys failed", {
      worker: workerName,
      data: { project: projectName, error: String(err) },
    });
    return false;
  }
  updateWorkerFields(projectName, workerName, { interruptedWhileWorking: undefined });
  log.info("workers", "continue sent", {
    worker: workerName,
    data: { project: projectName },
  });
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
// finalizeMerge and clears them after sending.
export function continueWorkerAfterMerge(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  const message = buildMergeContinuePrompt(
    projectName,
    entry?.pendingContinueChangedFiles,
    entry?.pendingContinueSyncFailed,
    entry?.baseBranch,
  );
  const delivered = continueWorker(projectName, workerName, message);
  // Clear the transient stale-files / sync-failed context only once the prompt
  // actually landed. If the first attempt was skipped (worker still mid-turn),
  // leave them set so the retry leg re-emits the same enriched prompt.
  if (delivered && (entry?.pendingContinueChangedFiles || entry?.pendingContinueSyncFailed)) {
    updateWorkerFields(projectName, workerName, {
      pendingContinueChangedFiles: undefined,
      pendingContinueSyncFailed: undefined,
    });
  }
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

// Send a one-shot seed prompt read from a file. The seed dispatch's 6s delay
// usually covers bootstrap (git fetch, worktree add, npm install, claude TUI
// init), but a slow network can run longer; poll while the worker is still
// "loading" and send as soon as it transitions to any other state. Capped at
// 90s. Always deletes the file at the end.
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

  const deadline = Date.now() + 90_000;
  const poll = (): void => {
    const entry = findWorkerByName(projectName, workerName);
    if (!entry) {
      log.warn("workers", "seed skipped, worker missing", {
        worker: workerName,
        data: { project: projectName },
      });
      cleanup();
      return;
    }
    if (entry.agentStatus !== "loading") {
      continueWorker(projectName, workerName, message);
      cleanup();
      return;
    }
    if (Date.now() >= deadline) {
      log.warn("workers", "seed timed out, sending anyway", {
        worker: workerName,
        data: { project: projectName, agentStatus: entry.agentStatus },
      });
      continueWorker(projectName, workerName, message);
      cleanup();
      return;
    }
    setTimeout(poll, 2000);
  };
  poll();
}
