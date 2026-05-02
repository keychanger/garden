// Worker lifecycle: creation and destruction of Claude worker sessions.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { getProject, tryGetProject } from "../config.js";
import { readDashState, writeDashState, withStateLock } from "./state.js";
import { parkToHidden, restoreFromHidden } from "./layout.js";
import { refreshDashboard } from "./header.js";
import {
  tmux, tmuxDisplay, tmuxNewWindow, setPaneLabel, setPaneVar, shellEscape,
  getFirstPaneId, paneExists, windowExists,
  listHiddenWorkerWindows, killWindowSafe,
  getPaneSize, resizeWindow,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import {
  addWorker, removeWorker, findWorkerByName, getAllWorkerNames,
  updateWorkerFields, getWorkers,
} from "./registry.js";
import { log } from "./log.js";
import {
  buildWorktreeBootstrapScript, buildWorktreeResumeCommand, buildResumeCommand,
  createShellWindow, resolveGardenRunner, installClaudeHooks,
} from "./create.js";
import { worktreePath, resolveBaseBranch, branchExistsOnOrigin } from "./git.js";
import { ensureProjectPoller, killReviewWindow, stopProjectPoller } from "./poller.js";
import { dispatchDelayedContinue } from "./continue.js";
import { workerWindowName as workerWin, parkingWindowName, shellWindowName as shellWin, parseWorkerSuffix } from "./window-names.js";

export function newWorker(): void {
  withStateLock(() => {
    const state = readDashState();
    if (!state.activeProject) {
      tmuxDisplay("No project selected. Use ⌥1-⌥9 first.");
      return;
    }

    const project = getProject(state.activeProject);
    const existingNames = getAllWorkerNames();
    const workerName = generateWorkerName(existingNames);
    const sessionId = crypto.randomUUID();
    const branchName = workerName;
    const wtPath = worktreePath(state.activeProject, workerName);
    const gardenRunner = resolveGardenRunner();

    const baseBranch = resolveBaseBranch(project.path);

    // A worker whose base branch isn't on origin breaks silently: every
    // `origin/<base>..HEAD` check in the Stop hook and poller fails, so the
    // review cycle never starts. Reject up front with clear remediation.
    // Check is local-refs only — see branchExistsOnOrigin doc.
    if (!branchExistsOnOrigin(project.path, baseBranch)) {
      const msg = `Base branch '${baseBranch}' (current branch of ${project.path}) has no local origin/${baseBranch} ref. Push it, fetch it, or switch the main checkout to a pushed branch.`;
      tmuxDisplay(msg);
      log.error("workers", "rejected newWorker: base branch not on origin", {
        worker: workerName,
        data: { project: state.activeProject, baseBranch },
      });
      return;
    }

    // Write the bootstrap script that handles slow setup (git fetch, worktree
    // creation, npm install) inside the tmux pane so the window appears instantly
    // with progress output instead of blocking the hotkey handler.
    const scriptFile = buildWorktreeBootstrapScript(
      project.name, project.path, workerName, branchName, sessionId, wtPath, baseBranch,
    );

    // Show the new pane immediately — bootstrap runs inside it
    const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject);
    parkToHidden(parkName, state);

    const workerWindowName = workerWin(state.activeProject, workerName);

    const workerPaneId = tmuxNewWindow("-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", project.path,
      "sh", "-c", `sh ${shellEscape(scriptFile)}`);
    // Pre-size so the bootstrap script renders at the right pane size from
    // the start, avoiding SIGWINCH jitter when restoreFromHidden swaps it in.
    const rightSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
    if (rightSize) resizeWindow(workerWindowName, rightSize.width, rightSize.height);
    if (workerPaneId) setPaneLabel(workerPaneId, workerName);
    restoreFromHidden(workerWindowName, state);
    // Re-apply label after swap (swap-pane may not preserve pane options)
    if (state.activePaneId) setPaneLabel(state.activePaneId, workerName);

    addWorker(state.activeProject, {
      name: workerName,
      sessionId,
      task: "",
      worktreePath: wtPath,
      branchName,
      baseBranch,
      claudeStatus: "loading",
    });

    log.info("workers", "created", {
      worker: workerName,
      data: { project: state.activeProject, branch: branchName },
    });

    ensureProjectPoller(state.activeProject, gardenRunner);

    state.activePaneType = "worker";
    state.activeWindowName = workerWindowName;
    state.lastActiveWorker[state.activeProject] = workerWindowName;
    writeDashState(state);
    refreshDashboard({ state });
  });
}

export function killPane(): void {
  // Declare cleanup vars outside the lock so backgroundGitCleanup can run
  // after the lock is released — it only spawns a child process and does not
  // touch state.
  let cleanupRepoPath: string | undefined;
  let cleanupWtPath: string | undefined;
  let cleanupBranch: string | undefined;

  withStateLock(() => {
    const state = readDashState();

    if (state.activePaneType === "shell") {
      tmuxDisplay("Cannot kill project shell. Use ⌥x on workers only.");
      return;
    }

    if (!state.activePaneId || !paneExists(state.activePaneId)) {
      tmuxDisplay("No pane to kill.");
      return;
    }

    if (!state.activeProject) {
      writeDashState(state);
      return;
    }

    const killedWindowName = state.activeWindowName;
    const workerWindows = listHiddenWorkerWindows(state.activeProject);
    const project = getProject(state.activeProject);

    if (workerWindows.length > 0) {
      const targetWindow = workerWindows[0];
      const targetPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${targetWindow}`);
      if (targetPaneId) {
        const visibleSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
        if (visibleSize) resizeWindow(targetWindow, visibleSize.width, visibleSize.height);
        tmux("swap-pane", "-s", state.activePaneId, "-t", targetPaneId);
        killWindowSafe(targetWindow);
        state.activePaneId = targetPaneId;
        state.activePaneType = "worker";
        state.activeWindowName = targetWindow;
        // Re-apply pane variables lost during swap-pane
        const nextLabel = parseWorkerSuffix(targetWindow);
        if (nextLabel) {
          setPaneLabel(targetPaneId, nextLabel);
          const nextEntry = findWorkerByName(state.activeProject, nextLabel);
          if (nextEntry?.task) setPaneVar(targetPaneId, "garden_task", nextEntry.task);
        }
      }
    } else {
      const shellTarget = shellWin(state.activeProject);
      if (!windowExists(shellTarget)) {
        createShellWindow(state.activeProject, project.path);
      }
      const shellPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${shellTarget}`);
      if (shellPaneId) {
        const visibleSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
        if (visibleSize) resizeWindow(shellTarget, visibleSize.width, visibleSize.height);
        tmux("swap-pane", "-s", state.activePaneId, "-t", shellPaneId);
        killWindowSafe(shellTarget);
        state.activePaneId = shellPaneId;
        state.activePaneType = "shell";
        state.activeWindowName = shellTarget;
      }
    }

    if (killedWindowName && state.activeProject) {
      if (state.lastActiveWorker[state.activeProject] === killedWindowName) {
        delete state.lastActiveWorker[state.activeProject];
      }
      const killedWorkerName = parseWorkerSuffix(killedWindowName);
      if (killedWorkerName) {
        const entry = findWorkerByName(state.activeProject, killedWorkerName);

        killReviewWindow(state.activeProject, killedWorkerName);
        removeWorker(state.activeProject, killedWorkerName);
        log.info("workers", "killed", {
          worker: killedWorkerName,
          data: { project: state.activeProject, branch: entry?.branchName },
        });

        const remaining = getWorkers(state.activeProject);
        if (remaining.length === 0) {
          stopProjectPoller(state.activeProject);
        }

        if (entry) {
          cleanupRepoPath = project.path;
          cleanupWtPath = entry.worktreePath;
          cleanupBranch = entry.branchName;
        }
      }
    }

    writeDashState(state);
    refreshDashboard();
  });

  // Heavy git cleanup runs outside the lock — only spawns a background process.
  if (cleanupRepoPath) {
    backgroundGitCleanup(cleanupRepoPath, cleanupWtPath, cleanupBranch);
  }
}

// Kill and restart the Claude process in a worker's pane via `claude --resume`.
// The pane, pane ID, worktree, and registry entry all stay put; only the Claude
// process is replaced, which forces a fresh read of .claude/settings.json
// (hook config, permissions.defaultMode) and drops any transient session state
// that's interrupting the operator (e.g., stuck in plan mode with no cycle back
// to auto). Works on both visible and parked workers — we resolve the pane by
// the worker's tracked window name, not the currently-active pane.
export function bounceWorker(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) {
    throw new Error(`No worker '${workerName}' in project '${projectName}'.`);
  }
  if (!entry.sessionId) {
    throw new Error(
      `Worker ${projectName}/${workerName} has no sessionId — can't resume. ` +
      `It may pre-date the worktree workflow; kill and recreate it instead.`,
    );
  }

  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) {
    throw new Error(
      `Worker ${projectName}/${workerName} has no live pane. Reattach the dashboard first.`,
    );
  }

  const projectInfo = tryGetProject(projectName);
  // Prefer the baseBranch pinned at worker creation — resolving fresh here
  // would pick up a new main-checkout branch and silently break the worker
  // (same failure mode WorkerEntry.baseBranch was added to prevent).
  const baseBranch = entry.baseBranch
    ?? (projectInfo ? resolveBaseBranch(projectInfo.path) : undefined);

  // Rewrite .claude/settings.json so bounce picks up hook/sandbox
  // changes from a rebuilt garden. buildWorktreeResumeCommand doesn't do
  // this on its own (unlike buildResumeCommand); the attach-time resume
  // path in ensureDashboard() calls it for the same reason.
  if (entry.worktreePath && projectInfo) {
    installClaudeHooks(entry.worktreePath, projectInfo);
  }

  const resumeCmd = entry.worktreePath && entry.branchName && projectInfo
    ? buildWorktreeResumeCommand(
        projectName, projectInfo.path, entry.name, entry.branchName,
        entry.sessionId, baseBranch,
      )
    : buildResumeCommand(
        projectName,
        projectInfo?.path ?? entry.worktreePath ?? "",
        entry.sessionId,
      );

  // Capture pre-bounce status before we overwrite to "idle" — used to decide
  // whether to auto-send a continue prompt below.
  const wasWorking = entry.claudeStatus === "working";

  const cwd = entry.worktreePath ?? projectInfo?.path;
  const respawnArgs = ["respawn-pane", "-k"];
  if (cwd) respawnArgs.push("-c", cwd);
  respawnArgs.push("-t", paneId, "sh", "-c", resumeCmd);
  tmux(...respawnArgs);

  // --resume does not fire SessionStart, so write claudeStatus directly.
  // Mirrors the attach-time resume path in ensureDashboard().
  updateWorkerFields(projectName, workerName, { claudeStatus: "idle" });

  if (wasWorking) {
    dispatchDelayedContinue(resolveGardenRunner(), projectName, workerName);
  }

  log.info("workers", "bounced", {
    worker: workerName,
    data: { project: projectName, sessionId: entry.sessionId, wasWorking },
  });

  refreshDashboard();
}

// Bounce the worker whose pane is currently active in the dashboard. Used by
// the ⌥b hotkey. Refuses on the project shell (no session to resume).
export function bounceActiveWorker(): void {
  const state = readDashState();
  if (state.activePaneType !== "worker" || !state.activeProject || !state.activeWindowName) {
    tmuxDisplay("Bounce only works on worker panes.");
    return;
  }
  const workerName = parseWorkerSuffix(state.activeWindowName);
  if (!workerName) {
    tmuxDisplay("Could not identify active worker.");
    return;
  }
  try {
    bounceWorker(state.activeProject, workerName);
    tmuxDisplay(`Bounced ${workerName}.`);
  } catch (err) {
    tmuxDisplay(`Bounce failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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

function backgroundGitCleanup(
  repoPath: string,
  wtPath: string | undefined,
  branchName: string | undefined,
): void {
  const parts: string[] = [];
  if (wtPath) {
    parts.push(`git -C ${shellEscape(repoPath)} worktree remove ${shellEscape(wtPath)} --force`);
  }
  if (branchName) {
    parts.push(`git -C ${shellEscape(repoPath)} branch -D ${shellEscape(branchName)}`);
    parts.push(
      `git -C ${shellEscape(repoPath)} ls-remote --heads origin ${shellEscape(branchName)}`
      + ` | grep -q . && git -C ${shellEscape(repoPath)} push origin --delete ${shellEscape(branchName)}`,
    );
  }
  if (parts.length === 0) return;
  const script = parts.map(p => `(${p}) 2>/dev/null || true`).join("; ");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
}
