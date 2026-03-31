// Dashboard creation: initial setup, pane layout, worker resumption.
import fs from "node:fs";
import path from "node:path";
import {
  dashboardExists,
  DASHBOARD_SESSION,
} from "../session.js";
import { loadConfig, tryGetProject, SESSIONS_DIR } from "../config.js";
import { buildRulesContext, buildWorktreeRules } from "../rules.js";
import { readDashState, writeDashState, STATE_FILE } from "./state.js";
import { restoreFromHidden } from "./layout.js";
import { setupKeybindings } from "./hotkeys.js";
import { setupStatusBar, buildStatusCommand, updateHeaderVar } from "./header.js";
import {
  tmux, tmuxOutput, tmuxSplit, setPaneTitle, setPaneLabel, setPaneVar,
  getFirstPaneId, shellEscape,
} from "./tmux.js";
import { readRegistry } from "./registry.js";
import { log, truncateLog } from "./log.js";
import { validateAndHeal } from "./validate.js";
import { startPoller, SIGNAL_FIFO } from "./poller.js";
import { installPollTriggerHook, installClaudeHook, worktreeExists as wtExists } from "./git.js";

const DASHBOARD_COLS = 250;
const DASHBOARD_ROWS = 60;

export function resizeTerminal(): void {
  try {
    process.stdout.write(`\x1b[8;${DASHBOARD_ROWS};${DASHBOARD_COLS}t`);
  } catch { /* non-resizable terminal */ }
}

export function ensureDashboard(): void {
  if (dashboardExists()) {
    const state = readDashState();
    const healed = validateAndHeal(state);
    writeDashState(healed);

    // Resize status pane to correct height — attaching from a different
    // terminal size can squish panes since tmux redistributes proportionally.
    const config = loadConfig();
    const projectCount = Object.keys(config.projects).length;
    const statusHeight = Math.max(4, projectCount * 2 + 2);
    if (healed.statusPaneId) {
      try { tmux("resize-pane", "-t", healed.statusPaneId, "-y", String(statusHeight)); } catch { /* pane may be gone */ }
    }

    return;
  }

  truncateLog();
  log.info("dashboard", "creating new dashboard");
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

  tmux("set-option", "-t", DASHBOARD_SESSION, "set-titles", "on");
  tmux("set-option", "-t", DASHBOARD_SESSION, "set-titles-string", "garden");

  const gardenShellId = tmuxOutput(
    "display-message", "-t", `${DASHBOARD_SESSION}:main.0`, "-p", "#{pane_id}");

  const rightPaneId = tmuxSplit("-h", "-t", `${DASHBOARD_SESSION}:main.0`, "-c", firstPath, "-l", "60%");

  const statusId = tmuxSplit("-v", "-b", "-t", gardenShellId, "-l", String(statusHeight),
    "sh", "-c", statusCmd);

  try { tmux("resize-pane", "-t", statusId, "-y", String(statusHeight)); } catch { /* ignore */ }
  try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }

  setPaneTitle(statusId, "status");
  setPaneLabel(statusId, "status");
  setPaneTitle(gardenShellId, "garden");
  setPaneLabel(gardenShellId, "garden");
  if (firstProject) {
    setPaneLabel(rightPaneId, `shell-${firstProject}`);
    setPaneTitle(rightPaneId, firstProject);
  }

  // Clear scrollback created by resize events during split setup
  try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }
  tmux("send-keys", "-t", gardenShellId, "clear", "Enter");

  setupStatusBar(gardenRunner);

  const state: {
    activeProject: string | null;
    statusPaneId: string;
    gardenShellPaneId: string;
    gardenPaneType: "shell" | "logs" | null;
    gardenWindowName: string | null;
    activePaneId: string;
    activePaneType: "worker" | "shell" | null;
    activeWindowName: string | null;
  } = {
    activeProject: firstProject,
    statusPaneId: statusId,
    gardenShellPaneId: gardenShellId,
    gardenPaneType: "shell",
    gardenWindowName: null,
    activePaneId: rightPaneId,
    activePaneType: firstProject ? "shell" : null,
    activeWindowName: firstProject ? `_${firstProject}-shell` : null,
  };

  writeDashState(state);
  updateHeaderVar();

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
      if (!entry.sessionId) continue;
      if (entry.worktreePath && wtExists(entry.worktreePath)) {
        installPollTriggerHook(entry.worktreePath, gardenRunner);
        installClaudeHook(entry.worktreePath);
      }
      const workerCwd = entry.worktreePath ?? projectConfig.path;
      const resumeCmd = entry.worktreePath && entry.branchName
        ? buildWorktreeResumeCommand(projectName, projectConfig.path, entry.name, entry.branchName, entry.sessionId)
        : buildResumeCommand(projectName, projectConfig.path, entry.sessionId);
      const workerWindowName = `_${projectName}-worker-${entry.name}`;

      tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", workerCwd,
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
  startPoller(gardenRunner);

  if (firstResumedWindow && state.activePaneId) {
    tmux("select-pane", "-t", state.activePaneId);
  } else {
    tmux("select-pane", "-t", gardenShellId);
  }
}

export function createLogsWindow(): void {
  const windowName = "_garden-logs";
  const scriptFile = writeLogsScript();

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName,
    "sh", "-c", `sh ${shellEscape(scriptFile)}`);

  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "logs");
    setPaneTitle(paneId, "logs");
  }
}

function writeLogsScript(): string {
  const alertsFile = path.join(SESSIONS_DIR, "dashboard.alerts.json");
  const logFile = path.join(SESSIONS_DIR, "dashboard.log");
  const scriptFile = path.join(SESSIONS_DIR, "logs-view.sh");

  const script = `#!/bin/sh
# Move cursor to top-left and clear screen without flashing
refresh() {
  printf '\\033[H\\033[2J'
}

refresh
while true; do
  refresh
  echo "=== Alerts ==="
  echo ""
  if [ -f '${alertsFile}' ]; then
    node -e '
      var d = JSON.parse(require("fs").readFileSync("${alertsFile}","utf-8"));
      if (!d.alerts || !d.alerts.length) { console.log("  (none)"); }
      else { d.alerts.slice(-20).forEach(function(a) {
        var t = new Date(a.ts).toLocaleString();
        console.log("  [" + a.level.toUpperCase() + "] " + t + " " + a.project + (a.worker ? "/" + a.worker : "") + ": " + a.message);
      }); }
    '
  else
    echo "  (none)"
  fi
  echo ""
  echo "=== Recent Log ==="
  echo ""
  if [ -f '${logFile}' ]; then
    tail -30 '${logFile}' | node -e '
      var lines = require("fs").readFileSync("/dev/stdin","utf-8").trim().split("\\n");
      lines.forEach(function(l) {
        try {
          var e = JSON.parse(l);
          var t = new Date(e.ts).toLocaleString();
          var d = e.data ? " " + JSON.stringify(e.data) : "";
          console.log("  " + t + " [" + e.level + "] " + e.src + ": " + e.msg + d);
        } catch(x) { console.log("  " + l); }
      });
    '
  else
    echo "  (no log file)"
  fi
  sleep 10
done
`;

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(scriptFile, script, { mode: 0o755 });
  return scriptFile;
}

export function createShellWindow(projectName: string, projectPath: string): void {
  const windowName = `_${projectName}-shell`;
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, "-c", projectPath);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, `shell-${projectName}`);
    setPaneTitle(paneId, projectName);
  }
}

export function buildWorkerCommand(projectName: string, projectPath: string, sessionId: string): string {
  const contextFile = writeContextFile(projectName, projectPath);
  const claudeCmd = `claude --dangerously-skip-permissions --session-id ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  return `${claudeCmd}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

export function buildResumeCommand(projectName: string, projectPath: string, sessionId: string): string {
  const contextFile = writeContextFile(projectName, projectPath);
  const claudeCmd = `claude --dangerously-skip-permissions --resume ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  return `${claudeCmd}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

export function buildWorktreeWorkerCommand(
  projectName: string,
  projectPath: string,
  workerName: string,
  branchName: string,
  sessionId: string,
): string {
  const contextFile = writeWorktreeContextFile(projectName, projectPath, branchName);
  const claudeCmd = `claude --dangerously-skip-permissions --session-id ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  return `${claudeCmd}; ${pollSignalSnippet()} exec $SHELL`;
}

export function buildWorktreeResumeCommand(
  projectName: string,
  projectPath: string,
  workerName: string,
  branchName: string,
  sessionId: string,
): string {
  const contextFile = writeWorktreeContextFile(projectName, projectPath, branchName);
  const claudeCmd = `claude --dangerously-skip-permissions --resume ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  return `${claudeCmd}; ${pollSignalSnippet()} exec $SHELL`;
}

function pollSignalSnippet(): string {
  const fifo = SIGNAL_FIFO.replace(/'/g, "'\\''");
  return `[ -p '${fifo}' ] && (echo > '${fifo}') 2>/dev/null;`;
}

function writeContextFile(projectName: string, projectPath: string): string {
  const context = buildRulesContext(projectName, projectPath);
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}.context`);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(contextFile, context);
  return contextFile;
}

function writeWorktreeContextFile(
  projectName: string,
  projectPath: string,
  branchName: string,
): string {
  const base = buildRulesContext(projectName, projectPath);
  const worktreeRules = buildWorktreeRules(branchName);
  const context = `${base}\n\n${worktreeRules}`;
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}-${branchName}.context`);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(contextFile, context);
  return contextFile;
}

export function resolveGardenRunner(): string {
  const gardenBin = path.resolve(process.argv[1]);
  if (gardenBin.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(gardenBin));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    return fs.existsSync(tsxBin) ? `${tsxBin} ${gardenBin}` : `npx tsx ${gardenBin}`;
  }
  return `node ${gardenBin}`;
}

export function cleanupContextFiles(): void {
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (file.startsWith("dashboard-") && file.endsWith(".context")) {
        fs.unlinkSync(path.join(SESSIONS_DIR, file));
      }
    }
  } catch { /* sessions dir might not exist */ }
}
