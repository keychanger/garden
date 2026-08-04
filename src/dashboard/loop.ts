// Workflow-agnostic loop primitive — bounded iteration mechanics shared by
// workflows that respawn the worker with a fresh Claude context after each
// merge (trellis today; grow next). The workflow-specific bits (per-iteration
// data shape, continue-prompt content) come in via `LoopHooks`; this module
// knows nothing about trellises or seed prompts.
//
// Three exports:
//   - `LoopHooks` — the contract a workflow supplies to drive the primitive.
//   - `persistIteration` — write a new iteration counter via the hooks. The
//     caller is responsible for any budget check; this primitive does not
//     enforce a cap.
//   - `dispatchDelayedLoopContinue` — spawn a detached subprocess that sleeps
//     and then calls the workflow's internal continue subcommand.
//   - `loopAutoContinueAfterMerge` — the cold-respawn dance: kill Claude,
//     regenerate sessionId, respawn-pane, seed the upcoming iteration's
//     prompt via `dispatchDelayedSeed`.
//
// Living in its own file (rather than continue.ts) because the respawn
// command builder lives in create.ts and create.ts already imports from
// continue.ts for the default auto-continue. Putting the loop primitive in
// continue.ts would close that into a cycle.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import {
  buildWorktreeWorkerCommand,
  workerProject,
  type WorktreeCommandOptions,
} from "./create.js";
import { getHarness } from "./harness/index.js";
import { getHarnessCore, workerLaunchCompatibilityError } from "./harness/core.js";
import { dispatchDelayedSeed, paneHasOperatorDraft } from "./continue.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "./registry.js";
import { resolveGardenRunner } from "./runner.js";
import { tmuxWorkerCommand } from "./claude-env.js";
import { readDashState } from "./state.js";
import {
  tmux, shellEscape, getFirstPaneId, paneExists, windowExists,
} from "./tmux.js";
import { workerWindowName as workerWin } from "./window-names.js";

export interface LoopHooks {
  /** Read the current iteration counter from a worker entry's per-workflow
   *  data sub-object. Returns null when the sub-object is absent (defensive
   *  — should not happen for a properly-stamped worker). */
  readIteration(entry: WorkerEntry): { iteration: number; maxIterations: number } | null;

  /** Persist the next iteration counter. Workflow-specific because the
   *  field path differs (entry.trellis.iteration vs entry.grow.iteration). */
  writeIteration(projectName: string, workerName: string, next: number): void;

  /** Update the in-memory entry's iteration field to match what writeIteration
   *  just persisted. Callers that pass the entry to downstream code (e.g.
   *  prompt builders) rely on the in-memory copy reflecting the persisted
   *  value. */
  setInMemoryIteration(entry: WorkerEntry, next: number): void;

  /** Build the per-iteration continue prompt for the upcoming iteration.
   *  The hook reads the current iteration field on the entry and labels for
   *  iteration K+1 (the iteration about to start). Called inside
   *  `loopAutoContinueAfterMerge` after the cold respawn. */
  buildContinuePrompt(entry: WorkerEntry): string;

  /** Short tag used in log lines and seed-file naming (e.g., "trellis", "grow"). */
  logTag: string;
}

/** Persist the next iteration counter and update the in-memory entry. The
 *  caller computes the next value (typically `(state?.iteration ?? 0) + 1`)
 *  and is responsible for any budget gate; this primitive simply writes. */
export function persistIteration(
  projectName: string,
  workerName: string,
  entry: WorkerEntry,
  hooks: LoopHooks,
  next: number,
): void {
  hooks.writeIteration(projectName, workerName, next);
  hooks.setInMemoryIteration(entry, next);
}

/** Detached subprocess that defers ~5s, then dispatches the fresh-context
 *  respawn for a workflow with loop hooks. The subcommand string is the
 *  workflow's internal handler (e.g., "_trellis-continue-after-merge"). The
 *  delay matches the default auto-continue path: the new pane needs time to
 *  settle before we fire respawn-pane (the post-merge force-push and
 *  postMerge run in the foreground, but pane stdin is shared with claude —
 *  give it a beat).
 *
 *  Delay lives inside the spawned Node child via `--delay-ms`, not a `sh -c
 *  "sleep N && ..."` wrapper. The `sh` trampoline stays only because
 *  gardenRunner is a multi-token shell command ("node /path/cli.js"); the
 *  shell exec's straight into garden and exits — no standalone `sleep`. */
export function dispatchDelayedLoopContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
  internalSubcommand: string,
): void {
  const cmd =
    `${gardenRunner} dashboard ${internalSubcommand} --delay-ms 5000 `
    + `${shellEscape(projectName)} ${shellEscape(workerName)} 2>/dev/null`;
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* best effort — operator can re-arm via workflow-specific resume */
  }
}

/** Kill the worker's Claude process, respawn cold with a fresh sessionId,
 *  and seed the upcoming iteration's continue prompt. Persists the new
 *  sessionId before the respawn so any concurrent reads see truth.
 *
 *  Workflow-specific bookkeeping (model selection, trellis-relative-path
 *  resolution, etc.) is the caller's responsibility — this primitive takes
 *  the WorktreeCommandOptions as a parameter and does not know about
 *  workflow-specific options.
 *
 *  Returns true on a successful respawn-and-seed; false when a precondition
 *  fails (worker missing, worktree missing, pane missing, etc.). */
export function loopAutoContinueAfterMerge(
  projectName: string,
  workerName: string,
  hooks: LoopHooks,
  workerCommandOpts: WorktreeCommandOptions,
): boolean {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) {
    log.warn("workers", `${hooks.logTag} continue skipped, worker missing`, {
      worker: workerName, data: { project: projectName },
    });
    return false;
  }
  const project = tryGetProject(projectName);
  if (!project) return false;
  const wtPath = entry.worktreePath;
  const branchName = entry.branchName;
  if (!wtPath || !branchName) {
    log.warn("workers", `${hooks.logTag} continue skipped, missing worktree/branch`, {
      worker: workerName, data: { project: projectName },
    });
    return false;
  }

  const launchHarness = workerCommandOpts.harness ?? entry.harness;
  const launchProvider = workerCommandOpts.provider ?? entry.provider;
  const launchProject = workerProject(project, launchProvider);
  const compatibilityError = workerLaunchCompatibilityError(
    getHarnessCore(launchHarness),
    {
      workflow: entry.workflow ?? "default",
      provider: launchProject.provider ?? null,
    },
  );
  if (compatibilityError) {
    log.error("workers", `${hooks.logTag} continue rejected: incompatible harness capabilities`, {
      worker: workerName,
      data: { project: projectName, error: compatibilityError },
    });
    return false;
  }

  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) {
    log.warn("workers", `${hooks.logTag} continue skipped, no pane`, {
      worker: workerName, data: { project: projectName },
    });
    return false;
  }

  // Do NOT cold-respawn over an operator who has re-engaged this worker. The
  // respawn-pane -k below kills the pane's process and throws away its Claude
  // context — so if the operator paused it, is mid-turn (working/asking), or has
  // an unsent draft in the input box, defer and leave prState=merged. The
  // merged-state gate-reopen sweep (handleMerged) replays this decision on the
  // next poke, so the iteration resumes once the worker is idle again. Mirrors
  // continueWorker's paused/draft skips.
  if (
    entry.agentStatus === "paused"
    || entry.agentStatus === "working"
    || entry.agentStatus === "asking"
    || paneHasOperatorDraft(paneId)
  ) {
    log.info("workers", `${hooks.logTag} continue deferred, worker active or drafting`, {
      worker: workerName,
      data: { project: projectName, agentStatus: entry.agentStatus },
    });
    return false;
  }

  // Refresh hook config so a rebuilt garden's settings.json takes effect on
  // the cold respawn (mirrors bounceWorker's installRuntimeConfig call).
  // Under the worker's own backend, matching the respawn env below — a refresh
  // that reverted the sandbox to the project's provider would leave the loop's
  // next iteration pointed at one endpoint with another allowlisted.
  getHarness(launchHarness).installRuntimeConfig(
    wtPath, launchProject,
  );

  // Regenerate sessionId per iteration — Claude cold-starts in the pane with
  // no prior conversation history. Persist BEFORE the respawn so concurrent
  // reads see the new value.
  const newSessionId = getHarness(launchHarness).allocateSessionId();
  const respawnCmd = buildWorktreeWorkerCommand(
    projectName,
    project.path,
    workerName,
    branchName,
    newSessionId,
    entry.baseBranch,
    // The respawn must build with the same harness whose allocateSessionId
    // and installRuntimeConfig ran above — thread the entry's adapter
    // unless the hooks caller already pinned one.
    {
      ...workerCommandOpts,
      harness: launchHarness,
      // Same reasoning for the backend: a respawn must reach the same endpoint
      // the worker has been building against, not the project default.
      provider: launchProvider,  // "" = explicit first-party, preserved by ??
    },
  );
  updateWorkerFields(projectName, workerName, {
    sessionId: newSessionId,
    agentStatus: "loading",
    // Clear pending continue scaffolding — the loop seed handles
    // changed-files inline rather than via the default pendingContinue* path.
    pendingContinueChangedFiles: undefined,
    pendingContinueSyncFailed: undefined,
    // Clear merged state — a new iteration is about to begin.
    mergedAt: undefined,
  });

  // tmux respawn-pane -k: kills the existing process and starts a new one in
  // the same pane. Same primitive bounceWorker uses; the difference is we
  // pass --session-id (fresh) instead of --resume.
  try {
    tmuxWorkerCommand(
      launchProject,
      "respawn-pane", "-k", "-c", wtPath, "-t", paneId, "sh", "-c", respawnCmd,
    );
  } catch (err) {
    log.error("workers", `${hooks.logTag} respawn-pane failed`, {
      worker: workerName, data: { project: projectName, error: String(err) },
    });
    return false;
  }

  // Build the continue prompt and stash to a temp file for seedWorker —
  // dispatchDelayedSeed reads from a file (avoids long argv) and polls until
  // agentStatus exits "loading", then sends keys. The local `entry` was
  // captured BEFORE the updateWorkerFields call above, so its
  // pendingContinueChangedFiles is still populated for the prompt builder
  // to read. Disk has been cleared.
  const message = hooks.buildContinuePrompt(entry);
  const messageFile = path.join(
    SESSIONS_DIR,
    `${hooks.logTag}-seed-${projectName}-${workerName}-${Date.now()}.txt`,
  );
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(messageFile, message);
  } catch (err) {
    log.error("workers", `${hooks.logTag} seed file write failed`, {
      worker: workerName, data: { project: projectName, error: String(err) },
    });
    return false;
  }

  dispatchDelayedSeed(resolveGardenRunner(), projectName, workerName, messageFile);

  const iterState = hooks.readIteration(entry);
  log.info("workers", `${hooks.logTag}: respawned cold + seeded`, {
    worker: workerName,
    data: {
      project: projectName,
      iteration: (iterState?.iteration ?? 0) + 1,
      sessionId: newSessionId,
    },
  });
  return true;
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
