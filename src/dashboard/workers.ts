// Worker lifecycle: creation and destruction of Claude worker sessions.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { getProject, SESSIONS_DIR } from "../config.js";
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
} from "./registry.js";
import { log } from "./log.js";
import { buildWorktreeBootstrapScript, createShellWindow, resolveGardenRunner } from "./create.js";
import { worktreePath, resolveBaseBranch, isWorktreeDirty } from "./git.js";
import { ensureProjectPoller, killReviewWindow, stopProjectPoller } from "./poller.js";
import { getWorkers } from "./registry.js";

const KILL_CONFIRM_FILE = path.join(SESSIONS_DIR, "dashboard.kill-confirm.json");
const KILL_CONFIRM_TIMEOUT_MS = 5000;

function readKillConfirm(): { workerName: string; timestamp: number } | null {
  try {
    return JSON.parse(fs.readFileSync(KILL_CONFIRM_FILE, "utf-8"));
  } catch { return null; }
}

function writeKillConfirm(workerName: string): void {
  const tmpFile = `${KILL_CONFIRM_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ workerName, timestamp: Date.now() }));
  fs.renameSync(tmpFile, KILL_CONFIRM_FILE);
}

function clearKillConfirm(): void {
  try { fs.unlinkSync(KILL_CONFIRM_FILE); } catch { /* ignore */ }
}

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

    const baseBranch = resolveBaseBranch(project.path, project);

    // Write the bootstrap script that handles slow setup (git fetch, worktree
    // creation, npm install) inside the tmux pane so the window appears instantly
    // with progress output instead of blocking the hotkey handler.
    const scriptFile = buildWorktreeBootstrapScript(
      project.name, project.path, workerName, branchName, sessionId, wtPath, baseBranch,
    );

    // Show the new pane immediately — bootstrap runs inside it
    const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
    parkToHidden(parkName, state);

    const workerWindowName = `_${state.activeProject}-worker-${workerName}`;

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

export function killPane(opts: { force?: boolean } = {}): void {
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

    // Guard against silently destroying uncommitted work. The poller is blind
    // to anything that hasn't been committed, so a worker that did substantive
    // work but never ran `git commit` looks identical to an empty worker.
    // Without this check, ⌥x on a dirty worker tears down the worktree and
    // the work is gone with no recovery path.
    //
    // Uses a double-tap pattern: first ⌥x shows a warning, second ⌥x within
    // 5 seconds confirms the kill. This avoids tmux confirm-before which
    // silently fails when its run-shell callback can't launch a new process.
    if (!opts.force && killedWindowName && state.activeProject) {
      const nameMatch = killedWindowName.match(/-worker-(.+)$/);
      if (nameMatch) {
        const workerName = nameMatch[1];
        const entry = findWorkerByName(state.activeProject, workerName);
        if (entry?.worktreePath && isWorktreeDirty(entry.worktreePath)) {
          const pending = readKillConfirm();
          if (pending && pending.workerName === workerName
              && (Date.now() - pending.timestamp) < KILL_CONFIRM_TIMEOUT_MS) {
            clearKillConfirm();
            // Fall through to kill
          } else {
            writeKillConfirm(workerName);
            tmuxDisplay(`Worker '${workerName}' has uncommitted changes. ⌥x again to force kill.`);
            return;
          }
        }
      }
    }

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
        const nextNameMatch = targetWindow.match(/-worker-(.+)$/);
        if (nextNameMatch) {
          const nextLabel = nextNameMatch[1];
          setPaneLabel(targetPaneId, nextLabel);
          const nextEntry = findWorkerByName(state.activeProject, nextLabel);
          if (nextEntry?.task) setPaneVar(targetPaneId, "garden_task", nextEntry.task);
        }
      }
    } else {
      const shellWindowName = `_${state.activeProject}-shell`;
      if (!windowExists(shellWindowName)) {
        createShellWindow(state.activeProject, project.path);
      }
      const shellPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${shellWindowName}`);
      if (shellPaneId) {
        const visibleSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
        if (visibleSize) resizeWindow(shellWindowName, visibleSize.width, visibleSize.height);
        tmux("swap-pane", "-s", state.activePaneId, "-t", shellPaneId);
        killWindowSafe(shellWindowName);
        state.activePaneId = shellPaneId;
        state.activePaneType = "shell";
        state.activeWindowName = shellWindowName;
      }
    }

    if (killedWindowName && state.activeProject) {
      if (state.lastActiveWorker[state.activeProject] === killedWindowName) {
        delete state.lastActiveWorker[state.activeProject];
      }
      const nameMatch = killedWindowName.match(/-worker-(.+)$/);
      if (nameMatch) {
        const workerName = nameMatch[1];
        const entry = findWorkerByName(state.activeProject, workerName);

        killReviewWindow(state.activeProject, workerName);
        removeWorker(state.activeProject, workerName);
        log.info("workers", "killed", {
          worker: workerName,
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
