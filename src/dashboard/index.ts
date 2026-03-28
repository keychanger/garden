// Dashboard entry point: subcommand dispatch, creation, project switching,
// worker management, and pane navigation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  checkTmux,
  dashboardExists,
  attachDashboardSession,
  killDashboardSession,
  DASHBOARD_SESSION,
} from "../session.js";
import { loadConfig, getProject, tryGetProject, SESSIONS_DIR } from "../config.js";
import { buildRulesContext } from "../rules.js";
import { readDashState, writeDashState, STATE_FILE } from "./state.js";
import { parkToHidden, restoreFromHidden, swapToHidden } from "./layout.js";
import { setupKeybindings } from "./hotkeys.js";
import { setupStatusBar, buildStatusCommand, printHeader, refreshStatusPane } from "./header.js";
import {
  tmux, tmuxOutput, tmuxSplit, tmuxDisplay, setPaneTitle, setPaneLabel, setPaneVar,
  getFirstPaneId, paneExists, windowExists, shellEscape,
  listHiddenWorkerWindows, getPanePid,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import { addWorker, removeWorker, getAllWorkerNames, readRegistry } from "./registry.js";

// --- Entry point ---

export async function dashboard(args: string[]): Promise<void> {
  checkTmux();

  const sub = args[0];

  if (sub === "exit" || sub === "close") {
    if (!dashboardExists()) {
      console.log("No dashboard running.");
      return;
    }
    killDashboardSession();
    try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
    console.log("Dashboard closed.");
    return;
  }

  // Internal subcommands called by hotkeys
  if (sub === "_switch") return switchProject(args[1]);
  if (sub === "_new-worker") return newWorker();
  if (sub === "_focus-worker") return focusWorker();
  if (sub === "_focus-shell") return focusShell();
  if (sub === "_focus-garden") return focusGarden();
  if (sub === "_cycle-pane") return cyclePane(args[1] === "prev" ? -1 : 1);
  if (sub === "_kill-pane") return killPane();
  if (sub === "_header") return printHeader();

  if (sub === "help") {
    printDashboardHelp();
    return;
  }

  if (sub && sub !== "help") {
    throw new Error(`Unknown dashboard subcommand: ${sub}. Try 'garden dashboard help'.`);
  }

  // Default: create/attach
  ensureDashboard();
  console.log("Attaching to dashboard... (detach with ctrl-b d)");
  attachDashboardSession();
}

// --- Dashboard creation ---

function ensureDashboard(): void {
  if (dashboardExists()) return;

  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }

  const gardenRunner = resolveGardenRunner();
  const cwd = process.cwd();
  const statusCmd = buildStatusCommand(gardenRunner);

  const config = loadConfig();
  const projectCount = Object.keys(config.projects).length;
  const statusHeight = Math.max(4, projectCount * 2 + 2);

  const projectNames = Object.keys(config.projects);
  const firstProject = projectNames.length > 0 ? projectNames[0] : null;
  const firstPath = firstProject ? config.projects[firstProject].path : cwd;

  const cols = String(process.stdout.columns || 200);
  const rows = String(process.stdout.rows || 50);

  tmux(
    "new-session", "-d", "-s", DASHBOARD_SESSION, "-n", "main", "-c", cwd,
    "-x", cols, "-y", rows
  );

  const gardenShellId = tmuxOutput(
    "display-message", "-t", `${DASHBOARD_SESSION}:main.0`, "-p", "#{pane_id}");

  const rightPaneId = tmuxSplit("-h", "-t", `${DASHBOARD_SESSION}:main.0`, "-c", firstPath, "-l", "60%");

  const statusId = tmuxSplit("-v", "-b", "-t", gardenShellId, "-l", String(statusHeight),
    "sh", "-c", statusCmd);

  try { tmux("resize-pane", "-t", statusId, "-y", String(statusHeight)); } catch { /* ignore */ }

  setPaneTitle(statusId, "status");
  setPaneTitle(gardenShellId, "garden");
  if (firstProject) {
    setPaneLabel(rightPaneId, `shell-${firstProject}`);
    setPaneTitle(rightPaneId, firstProject);
  }

  setupStatusBar(gardenRunner);

  const state = {
    activeProject: firstProject,
    statusPaneId: statusId,
    gardenShellPaneId: gardenShellId,
    activePaneId: rightPaneId,
    activePaneType: firstProject ? "shell" as const : null,
    activeWindowName: firstProject ? `_${firstProject}-shell` : null,
  };

  if (!firstProject) {
    tmux("send-keys", "-t", rightPaneId,
      `echo "No projects added. Run: garden add [path]"`, "Enter");
  }

  // Resume workers from previous session
  const registry = readRegistry();
  let firstResumedWindow: string | null = null;

  for (const [projectName, entries] of Object.entries(registry.workers)) {
    const projectConfig = tryGetProject(projectName);
    if (!projectConfig) continue;

    for (const entry of entries) {
      if (!entry.sessionId) continue; // skip legacy entries without session ID
      const resumeCmd = buildResumeCommand(projectName, projectConfig.path, entry.sessionId);
      const workerWindowName = `_${projectName}-worker-${entry.name}`;

      tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", projectConfig.path,
        "sh", "-c", resumeCmd);

      const workerPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindowName}`);
      if (workerPaneId) {
        setPaneLabel(workerPaneId, entry.name);
        if (entry.task) setPaneVar(workerPaneId, "garden_task", entry.task);
      }

      if (projectName === state.activeProject && !firstResumedWindow) {
        firstResumedWindow = workerWindowName;
      }
    }
  }

  if (firstResumedWindow) {
    restoreFromHidden(firstResumedWindow, state);
    state.activePaneType = "worker";
    state.activeWindowName = firstResumedWindow;
  }

  writeDashState(state);
  setupKeybindings(gardenRunner);

  // Focus the worker pane if we resumed one (so user can interact with
  // Claude's resume picker), otherwise focus the garden shell.
  if (firstResumedWindow && state.activePaneId) {
    tmux("select-pane", "-t", state.activePaneId);
  } else {
    tmux("select-pane", "-t", gardenShellId);
  }
}

// --- Project switching ---

function switchProject(indexArg: string): void {
  const index = parseInt(indexArg, 10) - 1;
  const config = loadConfig();
  const projectNames = Object.keys(config.projects);

  if (index < 0 || index >= projectNames.length) {
    tmuxDisplay(`No project at index ${index + 1}`);
    return;
  }

  const projectName = projectNames[index];
  const project = config.projects[projectName];
  const state = readDashState();

  if (state.activeProject === projectName) {
    tmuxDisplay(`Already on ${projectName}`);
    return;
  }

  const parkName = state.activeWindowName ?? `_${state.activeProject ?? "none"}-active`;
  parkToHidden(parkName, state);

  if (windowExists(`_${projectName}-active`)) {
    restoreFromHidden(`_${projectName}-active`, state);
    state.activePaneType = "worker";
    state.activeWindowName = `_${projectName}-active`;
  } else if (windowExists(`_${projectName}-shell`)) {
    restoreFromHidden(`_${projectName}-shell`, state);
    state.activePaneType = "shell";
    state.activeWindowName = `_${projectName}-shell`;
  } else {
    createShellWindow(projectName, project.path);
    restoreFromHidden(`_${projectName}-shell`, state);
    state.activePaneType = "shell";
    state.activeWindowName = `_${projectName}-shell`;
  }

  state.activeProject = projectName;
  writeDashState(state);
  refreshStatusPane();
  tmuxDisplay(`Switched to ${projectName}`);
}

// --- Worker management ---

function newWorker(): void {
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No project selected. Use ⌥1-⌥9 first.");
    return;
  }

  const project = getProject(state.activeProject);
  const existingNames = getAllWorkerNames();
  const workerName = generateWorkerName(existingNames);
  const sessionId = crypto.randomUUID();
  const workerCmd = buildWorkerCommand(project.name, project.path, sessionId);

  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  parkToHidden(parkName, state);

  const workerWindowName = `_${state.activeProject}-worker-${workerName}`;

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", project.path,
    "sh", "-c", workerCmd);
  const workerPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindowName}`);
  if (workerPaneId) setPaneLabel(workerPaneId, workerName);
  restoreFromHidden(workerWindowName, state);

  addWorker(state.activeProject, { name: workerName, sessionId, task: "" });

  state.activePaneType = "worker";
  state.activeWindowName = workerWindowName;
  writeDashState(state);
  refreshStatusPane();
}

function focusWorker(): void {
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No project selected.");
    return;
  }

  if (state.activePaneType === "worker") {
    if (state.activePaneId && paneExists(state.activePaneId)) {
      tmux("select-pane", "-t", state.activePaneId);
    }
    return;
  }

  const workerWindows = listHiddenWorkerWindows(state.activeProject);
  if (workerWindows.length === 0) {
    tmuxDisplay("No workers. Press ⌥n to create one.");
    return;
  }

  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  swapToHidden(parkName, workerWindows[0], state);

  state.activePaneType = "worker";
  state.activeWindowName = workerWindows[0];
  writeDashState(state);
  refreshStatusPane();
}

function focusShell(): void {
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No project selected.");
    return;
  }

  if (state.activePaneType === "shell") {
    if (state.activePaneId && paneExists(state.activePaneId)) {
      tmux("select-pane", "-t", state.activePaneId);
    }
    return;
  }

  const project = getProject(state.activeProject);
  const shellWindowName = `_${state.activeProject}-shell`;

  if (!windowExists(shellWindowName)) {
    createShellWindow(state.activeProject, project.path);
  }

  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  swapToHidden(parkName, shellWindowName, state);

  state.activePaneType = "shell";
  state.activeWindowName = shellWindowName;
  writeDashState(state);
  refreshStatusPane();
}

function focusGarden(): void {
  const state = readDashState();
  if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
    tmux("select-pane", "-t", state.gardenShellPaneId);
  }
}

// --- Cycle through workers ---

function cyclePane(direction: 1 | -1): void {
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No project selected.");
    return;
  }

  const hiddenWorkers = listHiddenWorkerWindows(state.activeProject);
  const currentName = state.activeWindowName;
  const isCurrentWorker = currentName && currentName.includes("-worker-");

  const allWorkers = isCurrentWorker
    ? [...new Set([currentName, ...hiddenWorkers])].sort()
    : [...hiddenWorkers];

  if (allWorkers.length === 0) {
    tmuxDisplay("No workers to cycle to. Press ⌥n to create one.");
    return;
  }

  const currentIdx = currentName ? allWorkers.indexOf(currentName) : -1;
  let nextIdx: number;
  if (currentIdx === -1) {
    nextIdx = direction === 1 ? 0 : allWorkers.length - 1;
  } else {
    nextIdx = (currentIdx + direction + allWorkers.length) % allWorkers.length;
  }

  const targetWindow = allWorkers[nextIdx];
  if (targetWindow === currentName) return;

  const parkName = currentName ?? `_${state.activeProject}-active`;
  swapToHidden(parkName, targetWindow, state);

  state.activePaneType = "worker";
  state.activeWindowName = targetWindow;
  writeDashState(state);
  refreshStatusPane();
}

// --- Kill pane ---

function killPane(): void {
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
      tmux("swap-pane", "-s", state.activePaneId, "-t", targetPaneId);
      killWindowSafe(targetWindow);
      state.activePaneId = targetPaneId;
      state.activePaneType = "worker";
      state.activeWindowName = targetWindow;
    }
  } else {
    const shellWindowName = `_${state.activeProject}-shell`;
    if (!windowExists(shellWindowName)) {
      createShellWindow(state.activeProject, project.path);
    }
    const shellPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${shellWindowName}`);
    if (shellPaneId) {
      tmux("swap-pane", "-s", state.activePaneId, "-t", shellPaneId);
      killWindowSafe(shellWindowName);
      state.activePaneId = shellPaneId;
      state.activePaneType = "shell";
      state.activeWindowName = shellWindowName;
    }
  }

  if (killedWindowName && state.activeProject) {
    const nameMatch = killedWindowName.match(/-worker-(.+)$/);
    if (nameMatch) removeWorker(state.activeProject, nameMatch[1]);
  }

  writeDashState(state);
  refreshStatusPane();
}

// --- Worker command builder ---

function buildWorkerCommand(projectName: string, projectPath: string, sessionId: string): string {
  const contextFile = writeContextFile(projectName, projectPath);
  const claudeCmd = `claude --dangerously-skip-permissions --session-id ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  return `${claudeCmd}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

function buildResumeCommand(projectName: string, projectPath: string, sessionId: string): string {
  const contextFile = writeContextFile(projectName, projectPath);
  const claudeCmd = `claude --dangerously-skip-permissions --resume ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  return `${claudeCmd}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

function writeContextFile(projectName: string, projectPath: string): string {
  const context = buildRulesContext(projectName, projectPath);
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}.context`);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(contextFile, context);
  return contextFile;
}

// --- Shell window creation ---

function createShellWindow(projectName: string, projectPath: string): void {
  const windowName = `_${projectName}-shell`;
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, "-c", projectPath);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, `shell-${projectName}`);
    setPaneTitle(paneId, projectName);
  }
}

// --- Helpers ---

function resolveGardenRunner(): string {
  const gardenBin = path.resolve(process.argv[1]);
  if (gardenBin.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(gardenBin));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    return fs.existsSync(tsxBin) ? `${tsxBin} ${gardenBin}` : `npx tsx ${gardenBin}`;
  }
  return `node ${gardenBin}`;
}

// Re-import for killPane (used directly, not through layout.ts)
import { killWindowSafe } from "./tmux.js";

// --- Help ---

function printDashboardHelp(): void {
  console.log(`
garden dashboard — multi-project control center

Usage:
  garden dashboard                 Open the dashboard (creates if needed)
  garden dashboard exit            Close the dashboard

Layout:
  Left: project status (upper, auto-sized) + garden shell (lower).
  Right: active pane (worker or shell). Info in status bar.

Hotkeys (⌥ = Option/Alt, no prefix needed):
  ⌥1 – ⌥9     Switch to project by number
  ⌥n           New worker (Claude session)
  ⌥w           Jump to first worker
  ⌥s           Jump to project shell
  ⌥] / ⌥[     Cycle between workers
  ⌥x           Kill current worker (shell is protected)
  ⌥g           Focus garden shell

Setup:
  iTerm2: Profiles → Keys → Left Option key → "Esc+"

Navigation:
  ctrl-b d     Detach (everything keeps running)
  ctrl-b z     Zoom/unzoom current pane
`.trim());
}
