// Dashboard creation: initial setup, pane layout, worker resumption.
import fs from "node:fs";
import path from "node:path";
import {
  dashboardExists,
  DASHBOARD_SESSION,
} from "../session.js";
import { loadConfig, tryGetProject, getFocusedProjectNames, SESSIONS_DIR, type ProjectConfig } from "../config.js";
import { buildRulesContext, buildWorktreeRules } from "../rules.js";
import { type DashboardState, readDashState, writeDashState, STATE_FILE } from "./state.js";
import { restoreFromHidden } from "./layout.js";
import { setupKeybindings } from "./hotkeys.js";
import { setupStatusBar, buildStatusCommand, updateHeaderVar } from "./header.js";
import { renderQuickStatus } from "../commands/status.js";
import {
  tmux, tmuxOutput, tmuxSplit, setPaneTitle, setPaneLabel, setPaneVar,
  getFirstPaneId, shellEscape,
  getPaneSize, resizeWindow, listAllWindowNames,
} from "./tmux.js";
import { readRegistry, updateWorkerFields } from "./registry.js";
import { log, truncateLog } from "./log.js";
import { validateAndHeal } from "./validate.js";
import { startProjectPoller, signalFifoPath } from "./poller.js";
import { startUsagePoller } from "./usage-poller.js";
import { installPollTriggerHook, worktreeExists as wtExists, resolveBaseBranch, getRemoteHost } from "./git.js";
import { buildSandboxConfig, type SandboxConfig } from "./sandbox.js";
import { gardenWindowName, shellWindowName as shellWin, workerWindowName as workerWin, isGardenWindow } from "./window-names.js";

const DASHBOARD_COLS = 250;
const DASHBOARD_ROWS = 60;

function buildSettingsJson(gardenRunner: string, sandbox: SandboxConfig): string {
  const hookCmd = `${gardenRunner} dashboard _claude-hook`;
  return JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} sessionstart`, timeout: 5 }],
      }],
      UserPromptSubmit: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} prompt`, timeout: 5 }],
      }],
      Stop: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} stop`, timeout: 5 }],
      }],
      PreToolUse: [{
        matcher: "AskUserQuestion",
        hooks: [{ type: "command", command: `${hookCmd} pretooluse`, timeout: 5 }],
      }, {
        matcher: "ExitPlanMode",
        hooks: [{ type: "command", command: `${hookCmd} pretooluse`, timeout: 5 }],
      }],
      PostToolUse: [{
        matcher: "AskUserQuestion",
        hooks: [{ type: "command", command: `${hookCmd} posttooluse`, timeout: 5 }],
      }, {
        matcher: "ExitPlanMode",
        hooks: [{ type: "command", command: `${hookCmd} posttooluse`, timeout: 5 }],
      }],
    },
    sandbox,
    permissions: { defaultMode: "acceptEdits" },
  }, null, 2);
}

// Build the sandbox config for a Claude session rooted at targetDir. The
// worktree path becomes the writable root; the project's origin remote host
// is auto-added to the network allowlist; per-project sandboxDomains extend it.
function sandboxForTarget(targetDir: string, project: ProjectConfig): SandboxConfig {
  return buildSandboxConfig({
    worktreePath: targetDir,
    project,
    remoteHost: getRemoteHost(project.path),
  });
}

export function installClaudeHooks(targetDir: string, project: ProjectConfig): void {
  const sandbox = sandboxForTarget(targetDir, project);
  const json = buildSettingsJson(resolveGardenRunner(), sandbox);
  const claudeDir = path.join(targetDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.local.json"), json);
}

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

    // Respawn the status pane with the current buildStatusCommand script so
    // any code changes take effect immediately without a full dashboard reset.
    // pane-border-status top adds one row to the total pane height, so size
    // to content lines + 1 to keep the content area exactly right.
    const gardenRunner = resolveGardenRunner();
    const statusHeight = Math.max(4, renderQuickStatus(healed).split("\n").length) + 1;
    if (healed.statusPaneId) {
      const statusCmd = buildStatusCommand(gardenRunner);
      try { tmux("respawn-pane", "-k", "-t", healed.statusPaneId, "sh", "-c", statusCmd); } catch { /* ignore */ }
      try { tmux("resize-pane", "-t", healed.statusPaneId, "-y", String(statusHeight)); } catch { /* pane may be gone */ }
      try { tmux("clear-history", "-t", healed.statusPaneId); } catch { /* ignore */ }
    }

    // Pre-size all hidden windows to match their target visible slots so
    // that swap-pane never triggers a SIGWINCH reflow. Without this, hidden
    // windows sit at full session width and the first swap causes jitter.
    presizeHiddenWindows(healed);

    return;
  }

  truncateLog();
  log.info("dashboard", "creating new dashboard");
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }

  const gardenRunner = resolveGardenRunner();
  const cwd = process.cwd();
  const statusCmd = buildStatusCommand(gardenRunner);

  const config = loadConfig();
  const focusedNames = getFocusedProjectNames(config);
  const projectCount = focusedNames.length;
  const statusHeight = Math.max(4, projectCount * 2 + 2);

  const firstProject = focusedNames.length > 0 ? focusedNames[0] : null;
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
  try { tmux("set-option", "-p", "-t", statusId, "history-limit", "0"); } catch { /* ignore */ }
  try { tmux("set-option", "-t", DASHBOARD_SESSION, "-u", "history-limit"); } catch { /* ignore */ }
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

  // Initialize the garden console with custom prompt and command dispatch
  const consoleInit = writeConsoleInitScript(gardenRunner);
  tmux("send-keys", "-t", gardenShellId, `source ${shellEscape(consoleInit)} && clear`, "Enter");

  setupStatusBar(gardenRunner);

  // tmux pane-died hook: when a worker pane process exits, write
  // claudeStatus="exited" to the registry. This is the only mechanism in
  // the new status model that observes process liveness — and tmux delivers
  // it as an event, not a poll.
  try {
    tmux("set-hook", "-t", DASHBOARD_SESSION, "pane-died",
      `run-shell "${gardenRunner} dashboard _pane-died '#{window_name}' 2>/dev/null"`);
  } catch { /* hooks may not be supported on very old tmux */ }

  // tmux pane-title-changed hook: Claude Code sets the pane title via escape
  // sequences as it works. This hook captures those changes live so task
  // summaries in the status pane and pane border stay current without polling.
  try {
    tmux("set-hook", "-t", DASHBOARD_SESSION, "pane-title-changed",
      `run-shell -b "${gardenRunner} dashboard _title-changed '#{window_name}' '#{pane_id}' 2>/dev/null"`);
  } catch { /* hooks may not be supported on very old tmux */ }

  const state: DashboardState = {
    activeProject: firstProject,
    statusPaneId: statusId,
    gardenShellPaneId: gardenShellId,
    gardenPaneType: "garden",
    gardenWindowName: gardenWindowName("garden"),
    activePaneId: rightPaneId,
    activePaneType: firstProject ? "shell" : null,
    activeWindowName: firstProject ? shellWin(firstProject) : null,
    lastActiveWorker: {},
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
  const rightSize = getPaneSize(rightPaneId);

  for (const [projectName, entries] of Object.entries(registry.workers)) {
    const projectConfig = tryGetProject(projectName);
    if (!projectConfig) continue;

    const baseBranch = resolveBaseBranch(projectConfig.path, projectConfig);
    for (const entry of entries) {
      if (!entry.sessionId) continue;
      if (entry.worktreePath && wtExists(entry.worktreePath)) {
        installPollTriggerHook(entry.worktreePath, gardenRunner, projectName);
        installClaudeHooks(entry.worktreePath, projectConfig);
      }
      // Claude Code does not fire SessionStart on --resume, so the SessionStart
      // hook will not write claudeStatus for resumed workers. Write "idle"
      // directly: a resumed worker is at the prompt by definition, and the
      // first user prompt will flip it to "working" via UserPromptSubmit.
      // prState is preserved as-is from the previous session.
      updateWorkerFields(projectName, entry.name, { claudeStatus: "idle" });
      const workerCwd = entry.worktreePath ?? projectConfig.path;
      const resumeCmd = entry.worktreePath && entry.branchName
        ? buildWorktreeResumeCommand(projectName, projectConfig.path, entry.name, entry.branchName, entry.sessionId, baseBranch)
        : buildResumeCommand(projectName, projectConfig.path, entry.sessionId);
      const workerWindowName = workerWin(projectName, entry.name);

      tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", workerCwd,
        "sh", "-c", resumeCmd);
      // Pre-size so the resumed worker renders at the right pane size from
      // the start, avoiding SIGWINCH jitter on first swap.
      if (rightSize) resizeWindow(workerWindowName, rightSize.width, rightSize.height);

      const workerPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindowName}`);
      if (workerPaneId) {
        setPaneLabel(workerPaneId, entry.name);
        if (entry.task) {
          setPaneVar(workerPaneId, "garden_task", entry.task);
          setPaneTitle(workerPaneId, entry.task);
        }
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

  // Resize status pane to exact content height now that all workers are
  // resumed and their windows exist — worker rows are now visible to
  // renderQuickStatus, giving an accurate line count.
  // +1 accounts for the pane-border-status top row (set by setupStatusBar above).
  const exactStatusHeight = Math.max(4, renderQuickStatus(state).split("\n").length) + 1;
  try { tmux("resize-pane", "-t", statusId, "-y", String(exactStatusHeight)); } catch { /* ignore */ }
  try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }

  setupKeybindings(gardenRunner);

  // Start per-project pollers for projects that have workers
  for (const [pn, entries] of Object.entries(registry.workers)) {
    if (entries.length > 0) {
      startProjectPoller(pn, gardenRunner);
    }
  }

  startUsagePoller(gardenRunner);

  if (firstResumedWindow && state.activePaneId) {
    tmux("select-pane", "-t", state.activePaneId);
  } else {
    tmux("select-pane", "-t", gardenShellId);
  }
}

export function createLogsWindow(): void {
  const windowName = gardenWindowName("logs");
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
  const scriptFile = path.join(SESSIONS_DIR, "logs-view.sh");

  // Use garden logs --follow for live-tailing with pretty formatting.
  // GARDEN_PRETTY=1 forces TTY-style color output inside the tmux pane.
  const script = `#!/bin/sh
export GARDEN_PRETTY=1
exec garden logs --follow
`;

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(scriptFile, script, { mode: 0o755 });
  return scriptFile;
}

export function createGardenConsoleWindow(gardenRunner: string): void {
  const consoleInit = writeConsoleInitScript(gardenRunner);
  const windowName = gardenWindowName("garden");
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "garden");
    setPaneTitle(paneId, "garden");
    tmux("send-keys", "-t", paneId, `source ${shellEscape(consoleInit)} && clear`, "Enter");
  }
}

export function createGardenRootWindow(): void {
  const windowName = gardenWindowName("root");
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "root");
    setPaneTitle(paneId, "root");
  }
}

export function createShellWindow(projectName: string, projectPath: string): void {
  const windowName = shellWin(projectName);
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, "-c", projectPath);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, `shell-${projectName}`);
    setPaneTitle(paneId, projectName);
  }
}

export function buildWorkerCommand(projectName: string, projectPath: string, sessionId: string): string {
  const project = resolveProjectForHooks(projectName, projectPath);
  installClaudeHooks(projectPath, project);
  const gardenRunner = shellEscape(resolveGardenRunner());
  const contextFile = writeContextFile(projectName, projectPath);
  const claudeCmd = `claude --session-id ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${claudeCmd}; ${exitHook}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

export function buildResumeCommand(projectName: string, projectPath: string, sessionId: string): string {
  const project = resolveProjectForHooks(projectName, projectPath);
  installClaudeHooks(projectPath, project);
  const gardenRunner = shellEscape(resolveGardenRunner());
  const contextFile = writeContextFile(projectName, projectPath);
  const claudeCmd = `claude --resume ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${claudeCmd}; ${exitHook}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

export function buildWorktreeWorkerCommand(
  projectName: string,
  projectPath: string,
  workerName: string,
  branchName: string,
  sessionId: string,
  baseBranch?: string,
): string {
  const contextFile = writeWorktreeContextFile(projectName, projectPath, branchName, baseBranch);
  const claudeCmd = `claude --session-id ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  return `${claudeCmd}; ${pollSignalSnippet(projectName)} exec $SHELL`;
}

// Resolve a ProjectConfig for installClaudeHooks. Callers of buildWorkerCommand
// only carry a name and path (pre-worktree API shape), so look up the registered
// project when possible and fall back to a minimal stub for unknown projects
// (e.g., tests or ad-hoc invocations).
function resolveProjectForHooks(projectName: string, projectPath: string): ProjectConfig {
  const registered = tryGetProject(projectName);
  return registered ?? { path: projectPath };
}

/**
 * Write a shell script that sets up the worktree and launches claude.
 * The slow work (git fetch, worktree add, npm install) runs inside the
 * tmux pane so the window appears instantly with progress output.
 */
export function buildWorktreeBootstrapScript(
  projectName: string,
  projectPath: string,
  workerName: string,
  branchName: string,
  sessionId: string,
  wtPath: string,
  baseBranch?: string,
): string {
  // Write the context file eagerly (fast, just file I/O)
  const contextFile = writeWorktreeContextFile(projectName, projectPath, branchName, baseBranch);

  const fifo = signalFifoPath(projectName).replace(/'/g, "'\\''");
  const pollSignal = `[ -p '${fifo}' ] && (echo > '${fifo}') 2>/dev/null;`;

  const escapedProjectPath = shellEscape(projectPath);
  const escapedWtPath = shellEscape(wtPath);
  const escapedContextFile = shellEscape(contextFile);
  const escapedHooksDir = shellEscape(path.join(wtPath, ".garden-hooks"));
  const escapedHookPath = shellEscape(path.join(wtPath, ".garden-hooks", "pre-push"));
  const signalFifoPath_ = path.join(SESSIONS_DIR, `${projectName}-poll-signal`);

  // Build the hook script content with the actual fifo path baked in
  const hookContent = [
    "#!/bin/sh",
    `FIFO='${signalFifoPath_.replace(/'/g, "'\\''")}'`,
    'if [ -p "$FIFO" ]; then',
    '  (echo > "$FIFO") </dev/null >/dev/null 2>&1 &',
    'fi',
    'exit 0',
  ].join("\\n");

  const gardenRunner = resolveGardenRunner();
  const escapedGardenRunner = shellEscape(gardenRunner);
  const project = resolveProjectForHooks(projectName, projectPath);
  const sandbox = sandboxForTarget(wtPath, project);
  const settingsJson = buildSettingsJson(gardenRunner, sandbox);
  const escapedHooksJson = settingsJson.replace(/'/g, "'\\''");

  const base = baseBranch ?? "main";
  const escapedBase = base.replace(/'/g, "'\\''");
  const escapedProjectName = projectName.replace(/'/g, "'\\''");

  const script = `#!/bin/sh
set -e

printf 'Setting up worktree %s...\\n' '${branchName}'

# Fetch latest base ref. Worker always branches off origin/${base}
# directly (see "git worktree add" below), so main-checkout freshness is
# informational only — but a stale main checkout signals operator rot and
# deserves an alert.
printf '  Fetching origin/%s...\\n' '${escapedBase}'
BOOTSTRAP_FAIL=""
FETCH_RC=0
FETCH_OUT=$(git -C ${escapedProjectPath} fetch origin '${escapedBase}' 2>&1) || FETCH_RC=$?
[ -n "$FETCH_OUT" ] && printf '%s\\n' "$FETCH_OUT"
if [ "$FETCH_RC" -ne 0 ]; then
  BOOTSTRAP_FAIL="fetch failed: $FETCH_OUT"
fi

printf '  Fast-forwarding main checkout...\\n'
MERGE_RC=0
MERGE_OUT=$(git -C ${escapedProjectPath} merge --ff-only 'origin/${escapedBase}' 2>&1) || MERGE_RC=$?
[ -n "$MERGE_OUT" ] && printf '%s\\n' "$MERGE_OUT"
if [ "$MERGE_RC" -ne 0 ]; then
  BOOTSTRAP_FAIL="\${BOOTSTRAP_FAIL:+$BOOTSTRAP_FAIL; }ff-merge failed: $MERGE_OUT"
fi

if [ -n "$BOOTSTRAP_FAIL" ]; then
  printf '  WARNING: main checkout did not update cleanly — raising alert.\\n' >&2
  ${escapedGardenRunner} dashboard _bootstrap-alert '${escapedProjectName}' '${escapedBase}' ${escapedProjectPath} "$BOOTSTRAP_FAIL" 2>/dev/null || true
fi

# Create worktree. Branch explicitly off origin/${base} so worker freshness
# does not depend on the main checkout being clean or up to date.
printf '  Creating worktree...\\n'
mkdir -p "$(dirname ${escapedWtPath})"
git -C ${escapedProjectPath} worktree add ${escapedWtPath} -b '${branchName}' 'origin/${escapedBase}'

# Install dependencies if needed
if [ -f ${escapedWtPath}/package.json ]; then
  printf '  Installing dependencies...\\n'
  (cd ${escapedWtPath} && npm install --prefer-offline) 2>/dev/null || true
fi

# Install poll trigger hook
mkdir -p ${escapedHooksDir}
printf '${hookContent}\\n' > ${escapedHookPath}
chmod 755 ${escapedHookPath}
git -C ${escapedWtPath} config --local core.hooksPath ${escapedHooksDir}

# Install Claude Code hooks for event-driven status updates
mkdir -p ${escapedWtPath}/.claude
printf '%s' '${escapedHooksJson}' > ${escapedWtPath}/.claude/settings.local.json

# Ensure garden-managed dirs are excluded from git status.
# Writing to the common info/exclude covers all worktrees and never gets committed.
EXCLUDE_FILE="$(git -C ${escapedWtPath} rev-parse --git-common-dir)/info/exclude"
for pattern in .claude/ .garden-hooks/; do
  grep -qxF "$pattern" "$EXCLUDE_FILE" 2>/dev/null || printf '%s\\n' "$pattern" >> "$EXCLUDE_FILE"
done

# Switch to the worktree directory
cd ${escapedWtPath}
printf '  Ready.\\n\\n'

# Launch claude
claude --session-id ${sessionId} --append-system-prompt-file ${escapedContextFile}
${escapedGardenRunner} dashboard _claude-hook stop 2>/dev/null || true
${pollSignal}
exec $SHELL
`;

  const scriptFile = path.join(SESSIONS_DIR, `bootstrap-${projectName}-${branchName}.sh`);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(scriptFile, script, { mode: 0o755 });
  return scriptFile;
}

export function buildWorktreeResumeCommand(
  projectName: string,
  projectPath: string,
  workerName: string,
  branchName: string,
  sessionId: string,
  baseBranch?: string,
): string {
  const contextFile = writeWorktreeContextFile(projectName, projectPath, branchName, baseBranch);
  const gardenRunner = shellEscape(resolveGardenRunner());
  const claudeCmd = `claude --resume ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${claudeCmd}; ${exitHook}; ${pollSignalSnippet(projectName)} exec $SHELL`;
}

function pollSignalSnippet(projectName: string): string {
  const fifo = signalFifoPath(projectName).replace(/'/g, "'\\''");
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
  baseBranch?: string,
): string {
  const base = buildRulesContext(projectName, projectPath);
  const worktreeRules = buildWorktreeRules(branchName, baseBranch);
  const context = `${base}\n\n${worktreeRules}`;
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}-${branchName}.context`);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(contextFile, context);
  return contextFile;
}

function writeConsoleInitScript(gardenRunner: string): string {
  const script = `# Garden console init — custom prompt with auto-dispatch
PS1=$'\\033[1;32mgarden>\\033[0m '

command_not_found_handler() {
  ${gardenRunner} "$@"
}
`;
  const scriptFile = path.join(SESSIONS_DIR, "console-init.zsh");
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(scriptFile, script, { mode: 0o644 });
  return scriptFile;
}

export function resolveGardenRunner(): string {
  const gardenBin = path.resolve(process.argv[1]);
  if (gardenBin.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(gardenBin));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    return fs.existsSync(tsxBin) ? `${tsxBin} ${gardenBin}` : `npx tsx ${gardenBin}`;
  }
  // Use absolute path for node so hooks work in minimal shell environments
  return `${process.execPath} ${gardenBin}`;
}

/**
 * Resize all hidden windows to match the visible pane they'll swap into.
 * Worker/shell windows match the right pane; garden/root/logs match the
 * garden pane. Called on attach so hidden windows are already sized
 * correctly before the first swap — avoiding the SIGWINCH race where
 * resize-window fires right before swap-pane and the TUI hasn't finished
 * redrawing yet.
 */
export function presizeHiddenWindows(state: DashboardState): void {
  const rightSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
  const gardenSize = state.gardenShellPaneId ? getPaneSize(state.gardenShellPaneId) : null;

  if (!rightSize && !gardenSize) return;

  const windows = listAllWindowNames();
  for (const name of windows) {
    if (name === "main") continue;

    // Garden pane targets
    if (isGardenWindow(name)) {
      if (gardenSize) resizeWindow(name, gardenSize.width, gardenSize.height);
      continue;
    }

    // Skip pollers and review windows — never swapped into a visible slot
    if (name.endsWith("-poller") || name.includes("-review-")) continue;

    // Worker and shell windows target the right pane
    if (rightSize) resizeWindow(name, rightSize.width, rightSize.height);
  }
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
