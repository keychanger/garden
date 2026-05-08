// Per-iteration context reset for trellis vines. See TRELLIS.md "Per-iteration
// context reset" — Invariant 8. The deliberate divergence from the default
// workflow's auto-continue: each iteration starts with a fresh Claude
// process, so conversation history does not compound across iterations.
//
// Sequence on a DRIFT-then-merge:
//   1. finalizeMerge synced the worktree to the merged tip.
//   2. dispatchDelayedTrellisContinue fires a detached subprocess that
//      sleeps a few seconds, then invokes `dashboard
//      _trellis-continue-after-merge <project> <worker>`.
//   3. trellisAutoContinueAfterMerge: regenerates the worker's sessionId
//      (Q6 — fresh UUID per iteration), respawns the worker's tmux pane
//      with `claude --session-id <new-uuid>` (no --resume), seeds the
//      seed prompt with the trellis continue text via the existing
//      seedWorker polling primitive.
//
// Lives in its own file (rather than continue.ts) because the respawn
// command builder (buildWorktreeWorkerCommand) and the hook installer
// (installClaudeHooks) live in create.ts — and create.ts already imports
// from continue.ts for the default auto-continue dispatch. Putting trellis
// auto-continue in continue.ts would close that into a cycle.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import {
  buildWorktreeWorkerCommand, installClaudeHooks, trellisRelativePathForEntry,
} from "./create.js";
import { dispatchDelayedSeed } from "./continue.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "./registry.js";
import { resolveGardenRunner } from "./runner.js";
import { readDashState } from "./state.js";
import {
  tmux, shellEscape, getFirstPaneId, paneExists, windowExists,
} from "./tmux.js";
import { resolveAndApplyVineModel } from "./trellis-model.js";
import { workerWindowName as workerWin } from "./window-names.js";
import { getWorkflow } from "./workflows/index.js";

const LESSONS_FILE_REL = path.join(".garden", "trellis-lessons.md");

// Detached subprocess that delays a few seconds, then dispatches the
// fresh-context respawn for a trellis vine. Mirrors
// `dispatchDelayedAutoContinue` in continue.ts but invokes the
// trellis-specific subcommand. The 5s delay matches the default
// auto-continue path; the new pane needs the same settle time before
// we fire respawn-pane (the post-merge force-push and postMerge run
// in the foreground, but pane stdin is shared with claude — give it
// a beat).
export function dispatchDelayedTrellisContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  const cmd =
    `sleep 5 && ${gardenRunner} dashboard _trellis-continue-after-merge `
    + `${shellEscape(projectName)} ${shellEscape(workerName)} 2>/dev/null`;
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* best effort — operator can re-arm via garden trellis resume */ }
}

// Kill the worker's Claude process, respawn cold with a fresh sessionId,
// and seed the trellis continue prompt. Persists the new sessionId to
// the registry before the respawn so any concurrent reads (status,
// bounce) see truth.
export function trellisAutoContinueAfterMerge(
  projectName: string,
  workerName: string,
): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) {
    log.warn("workers", "trellis continue skipped, worker missing", {
      worker: workerName, data: { project: projectName },
    });
    return;
  }
  if (entry.workflow !== "trellis") {
    log.warn("workers", "trellis continue called on non-trellis worker", {
      worker: workerName, data: { project: projectName, workflow: entry.workflow },
    });
    return;
  }
  const project = tryGetProject(projectName);
  if (!project) return;
  const wtPath = entry.worktreePath;
  const branchName = entry.branchName;
  if (!wtPath || !branchName) {
    log.warn("workers", "trellis continue skipped, missing worktree/branch", {
      worker: workerName, data: { project: projectName },
    });
    return;
  }

  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) {
    log.warn("workers", "trellis continue skipped, no pane", {
      worker: workerName, data: { project: projectName },
    });
    return;
  }

  // Refresh hook config so a rebuilt garden's settings.json takes effect
  // on the cold respawn (mirrors bounceWorker's installClaudeHooks call).
  installClaudeHooks(wtPath, project);

  // Regenerate sessionId per iteration (Q6) — Claude cold-starts in the
  // pane with no prior conversation history. Persist BEFORE the respawn
  // so concurrent reads see the new value.
  // Resolve this iteration's model. May fall back Sonnet → Opus, or
  // refuse outright (Sonnet exhausted + trellisOpusFallback=false). On
  // refusal, the global pause was flipped — skip the respawn entirely.
  // The next iteration fires when Sonnet resets or operator runs
  // `garden auto on`.
  const resolvedModel = resolveAndApplyVineModel(projectName, entry, getWorkflow("trellis"));
  if (resolvedModel === null) {
    log.warn("workers", "trellis continue skipped, vine paused on Sonnet exhaustion", {
      worker: workerName, data: { project: projectName },
    });
    return;
  }

  const newSessionId = crypto.randomUUID();
  const trellisRelativePath = trellisRelativePathForEntry(entry, project.path);
  const respawnCmd = buildWorktreeWorkerCommand(
    projectName,
    project.path,
    workerName,
    branchName,
    newSessionId,
    entry.baseBranch,
    { trellisRelativePath, model: resolvedModel },
  );
  updateWorkerFields(projectName, workerName, {
    sessionId: newSessionId,
    claudeStatus: "loading",
    // Clear pending continue scaffolding — the trellis seed handles
    // changed-files / drift-list inline rather than via the default
    // pendingContinue* path.
    pendingContinueChangedFiles: undefined,
    pendingContinueSyncFailed: undefined,
    // Clear merged state — a new iteration is about to begin.
    mergedAt: undefined,
  });

  // tmux respawn-pane -k: kills the existing process and starts a new one
  // in the same pane. Same primitive bounceWorker uses; the difference is
  // we pass --session-id (fresh) instead of --resume.
  const respawnArgs = ["respawn-pane", "-k", "-c", wtPath, "-t", paneId, "sh", "-c", respawnCmd];
  try {
    tmux(...respawnArgs);
  } catch (err) {
    log.error("workers", "trellis respawn-pane failed", {
      worker: workerName, data: { project: projectName, error: String(err) },
    });
    return;
  }

  // Build the seed prompt and stash it to a temp file for seedWorker —
  // dispatchDelayedSeed reads from a file (avoids long argv) and polls
  // until claudeStatus exits "loading", then sends keys.
  const message = buildTrellisContinuePrompt(entry);
  const messageFile = path.join(
    SESSIONS_DIR,
    `trellis-seed-${projectName}-${workerName}-${Date.now()}.txt`,
  );
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(messageFile, message);
  } catch (err) {
    log.error("workers", "trellis seed file write failed", {
      worker: workerName, data: { project: projectName, error: String(err) },
    });
    return;
  }

  dispatchDelayedSeed(resolveGardenRunner(), projectName, workerName, messageFile);

  log.info("workers", "trellis: respawned cold + seeded", {
    worker: workerName,
    data: {
      project: projectName,
      iteration: (entry.trellis?.iteration ?? 0) + 1,
      sessionId: newSessionId,
    },
  });
}

// Build the trellis continue prompt for iteration N+1. Reads
// `entry.trellis.iteration + 1` per TRELLIS.md (the increment fires inside
// the next launchReview, not here). See "Continue prompt structure".
export function buildTrellisContinuePrompt(entry: WorkerEntry): string {
  const t = entry.trellis;
  const upcomingIter = (t?.iteration ?? 0) + 1;
  const max = t?.maxIterations ?? 30;
  const trellisDisplay = trellisDisplayPath(entry);
  const driftLines = t?.lastDrift ?? [];
  const changed = entry.pendingContinueChangedFiles ?? [];
  const lessons = readLessonsFile(entry.worktreePath);

  const parts: string[] = [];
  parts.push(
    `[garden] Your previous iteration was merged. The trellis at \`${trellisDisplay}\` ` +
    `is your authority — read it before editing.`,
  );
  parts.push(`Iteration ${upcomingIter} of ${max}.`);

  if (changed.length > 0) {
    const list = changed.slice(0, 20).map(f => `  - ${f}`).join("\n");
    const tail = changed.length > 20 ? `\n  - ... (and ${changed.length - 20} more)` : "";
    parts.push(`Files that changed during review:\n${list}${tail}`);
  }

  if (driftLines.length > 0) {
    const list = driftLines.map(line => `  ${line}`).join("\n");
    parts.push(`Drift remaining:\n${list}`);
  } else {
    parts.push(
      "Drift remaining: (none reported by reviewer; if you believe the loop " +
      "is converged, write `.garden-done` at your worktree root before ending " +
      "your turn so the next merge terminates the loop instead of looping.)",
    );
  }

  if (lessons) {
    parts.push(
      `Lessons from previous iterations (\`${LESSONS_FILE_REL}\`):\n` +
      "```\n" + lessons + "\n```",
    );
  }

  parts.push(
    "Address the highest-priority drift item first. You may address others " +
    "in the same iteration if directly related, but do not chase adjacent " +
    "work — the trellis's \"Out of scope\" section bounds you. After your " +
    `changes, append a one-line entry to \`${LESSONS_FILE_REL}\` describing ` +
    "what you tried and what you learned. Commit and push when ready. The " +
    "reviewer will compare your work against the trellis; if all drift is " +
    "resolved, the loop ends.",
  );

  return parts.join("\n\n");
}

// --- Helpers -------------------------------------------------------------

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

function trellisDisplayPath(entry: WorkerEntry): string {
  const tPath = entry.trellis?.path;
  if (!tPath) return entry.trellis?.name ?? "<trellis>";
  const wt = entry.worktreePath;
  if (wt && tPath.startsWith(wt + path.sep)) {
    return tPath.slice(wt.length + 1);
  }
  return tPath;
}

function readLessonsFile(worktreePath: string | undefined): string | null {
  if (!worktreePath) return null;
  const lessonsPath = path.join(worktreePath, LESSONS_FILE_REL);
  try {
    const content = fs.readFileSync(lessonsPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
