// Dashboard creation: initial setup, pane layout, worker resumption.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  dashboardExists,
  DASHBOARD_SESSION,
} from "../session.js";
import { atomicWriteFile } from "./atomic-write.js";
import { loadConfig, tryGetProject, getFocusedProjectNames, firstFocusedPlotName, plotNames, SESSIONS_DIR, type ProjectConfig } from "../config.js";
import { buildRulesContext, buildWorktreeRules } from "../rules.js";
import { type DashboardState, readDashState, writeDashState, withStateLock, STATE_FILE } from "./state.js";
import { restoreFromHidden } from "./layout.js";
import { setupKeybindings } from "./hotkeys.js";
import { setupStatusBar, buildStatusCommand, buildUsageCommand, buildHistoryCommand, buildAlertsCommand, updateHeaderVar, installInputGuard, setPaneProjectColor } from "./header.js";
import { renderQuickStatus } from "../commands/status.js";
import { formatLogsPaneLabel } from "../commands/logs.js";
import {
  tmux, tmuxOutput, tmuxSplit, setPaneTitle, setPaneLabel, setPaneVar,
  getFirstPaneId, shellEscape, tmuxDoubleQuote, newDashboardWindow,
  getPaneSize, resizeWindow, listSessionPanes, disablePaneInput, lockPaneMouse,
} from "./tmux.js";
import { readRegistry, updateWorkerFields, resolveResumeAgentStatus, type WorkerEntry } from "./registry.js";
import { log, truncateLog } from "./log.js";
import { validateAndHeal } from "./validate.js";
import { startProjectPoller, signalFifoPath, restartLongLivedPollers } from "./poller.js";
import { startUsagePoller } from "./usage-poller.js";
import { startWatchdog } from "./watchdog.js";
import { installPollTriggerHook, worktreeExists as wtExists, getWorkerBaseBranch, getRemoteHost, getGitCommonDir } from "./git.js";
import { dispatchDelayedContinue } from "./continue.js";
import { resolveGardenRunner, resolveHookRunner } from "./runner.js";
import { buildSandboxConfig } from "./sandbox.js";
import {
  DONE_SKILL_CONTENT, DONE_SKILL_DIRNAME, DONE_SKILL_FILENAME,
  HANDOFF_SKILL_CONTENT, HANDOFF_SKILL_DIRNAME, HANDOFF_SKILL_FILENAME,
  TRELLIS_AUTHOR_SKILL_CONTENT, TRELLIS_AUTHOR_SKILL_DIRNAME, TRELLIS_AUTHOR_SKILL_FILENAME,
  GROW_SKILL_CONTENT, GROW_SKILL_DIRNAME, GROW_SKILL_FILENAME,
  BOTANIST_SKILL_CONTENT, BOTANIST_SKILL_DIRNAME, BOTANIST_SKILL_FILENAME,
} from "./skills.js";
import { workerEnvPrefix, syncAllProviderTokens } from "./claude-env.js";
import { getHarness } from "./harness/index.js";
import { buildSettingsJson } from "./harness/claude-code.js";
import { gardenWindowName, shellWindowName as shellWin, workerWindowName as workerWin, isGardenWindow } from "./window-names.js";

const DASHBOARD_COLS = 250;
const DASHBOARD_ROWS = 60;

// Usage pane height: 3 meter lines + 1 leading blank + 1 pane-border-status top row.
export const USAGE_PANE_HEIGHT = 5;

export function resizeTerminal(): void {
  try {
    process.stdout.write(`\x1b[8;${DASHBOARD_ROWS};${DASHBOARD_COLS}t`);
  } catch { /* non-resizable terminal */ }
}

export function ensureDashboard(): void {
  if (dashboardExists()) {
    // Reconcile dashboard state against tmux reality under the state lock, so
    // the whole read-modify-write is atomic against a concurrent hotkey
    // navigation (which also writes under withStateLock). The unlocked version
    // could revert such a write and leave activeWindowName pointing at a hidden
    // window the next park would killWindowSafe — destroying a live worker pane.
    // validateAndHeal's slow side tasks (registry mutation, prunes, poller
    // restarts) never acquire the state lock, so holding it across them cannot
    // deadlock; the hold is bounded and this runs only at attach.
    const healed = withStateLock(() => {
      const state = readDashState();
      const h = validateAndHeal(state);
      writeDashState(h);
      return h;
    });

    // Re-push provider API keys into the session env on every attach — this
    // process has the operator's shell env; the running server's env was
    // frozen at its creation.
    try { syncAllProviderTokens(loadConfig()); } catch { /* config unavailable */ }

    // Heal sessions from older builds that left history-limit at tmux's 2000-line default.
    try { tmux("set-option", "-t", DASHBOARD_SESSION, "history-limit", "1000000"); } catch { /* ignore */ }

    respawnStatusPane(healed);
    if (healed.usagePaneId) {
      const gardenRunner = resolveGardenRunner();
      const usageCmd = buildUsageCommand(gardenRunner);
      try { tmux("respawn-pane", "-k", "-t", healed.usagePaneId, "sh", "-c", usageCmd); } catch { /* ignore */ }
      try { tmux("resize-pane", "-t", healed.usagePaneId, "-y", String(USAGE_PANE_HEIGHT)); } catch { /* pane may be gone */ }
      try { tmux("clear-history", "-t", healed.usagePaneId); } catch { /* ignore */ }
      disablePaneInput(healed.usagePaneId);
      lockPaneMouse(healed.usagePaneId);
    }

    // Re-bake pane content + re-pin heights on terminal resize (the baked files
    // are width-shaped). Copy-mode-safe: the handler repaints via SIGUSR1 only,
    // never refresh-client, which broke copy-mode scrolling (a10642c).
    try {
      const gardenRunner = resolveGardenRunner();
      const inner = `${gardenRunner} dashboard _client-resized 2>/dev/null`;
      tmux("set-hook", "-t", DASHBOARD_SESSION, "client-resized",
        `run-shell -b ${tmuxDoubleQuote(inner)}`);
    } catch { /* hooks may not be supported on very old tmux */ }

    // Pre-size all hidden windows to match their target visible slots so
    // that swap-pane never triggers a SIGWINCH reflow. Without this, hidden
    // windows sit at full session width and the first swap causes jitter.
    presizeHiddenWindows(healed);

    // Re-install on reattach so dashboards from older builds pick up the guard.
    installInputGuard(healed);

    // Re-bind hotkeys with the current gardenRunner. tmux key bindings are
    // server-global and persist for the life of the tmux server — they bake in
    // the absolute path of whichever cli.js was running when the dashboard was
    // first created. If that cli.js's worktree later disappears (e.g., a worker
    // worktree was cleaned up after creating the dashboard), every hotkey
    // exits 1 with "no such file or directory". Rebinding on reattach pins
    // the keys to whatever cli.js the operator just ran (typically the
    // npm-link'd global), self-healing across worktree churn.
    try { setupKeybindings(resolveGardenRunner()); } catch { /* best effort */ }

    // Re-install per-worker hooks (.claude/settings.json + the pre-push
    // poll-trigger hook) for the same reason: they bake the gardenRunner path
    // at worker create time. If that path lived in a worktree that has since
    // been cleaned up, every Stop / UserPromptSubmit / PreToolUse hook exits
    // MODULE_NOT_FOUND and the worker stops reporting state to the dashboard.
    // Rewriting on reattach pins each worker's hooks to the current cli.js so
    // worktree churn no longer silently breaks live workers.
    try {
      const reg = readRegistry();
      for (const [pname, entries] of Object.entries(reg.workers)) {
        const proj = tryGetProject(pname);
        if (!proj) continue;
        for (const entry of entries) {
          if (!entry.worktreePath || !wtExists(entry.worktreePath)) continue;
          installPollTriggerHook(entry.worktreePath, resolveGardenRunner(), pname);
          getHarness(entry.harness).installRuntimeConfig(
            entry.worktreePath, workerProject(proj, entry.provider),
          );
        }
      }
    } catch { /* best effort — initial-create path will catch up next restart */ }

    // Respawn the project + usage poller windows so their bash-loop start
    // commands pick up the current gardenRunner. tmux's pane_start_command is
    // captured once at window creation and never re-read; if the dashboard
    // was first launched out of a worker worktree, every poller's loop runs
    // `node <ephemeral-worktree>/dist/cli.js dashboard _poll <project>`
    // forever. Once that worktree is cleaned up, every iteration hits
    // MODULE_NOT_FOUND, stderr is swallowed by `2>/dev/null`, and the FIFO
    // read still blocks — so the loop looks alive (pane not dead) but does
    // zero useful work. The whole review/merge pipeline silently stalls
    // across every project. restartLongLivedPollers does a kill+spawn for
    // each one with the current resolveGardenRunner() output. The brief
    // gap drops in-flight FIFO pokes; the hook that triggered them re-pokes
    // on the next event, so nothing is lost.
    try { restartLongLivedPollers(resolveGardenRunner()); } catch { /* best effort */ }

    // Heal logs panes from older builds that pre-date the creation-time disable.
    try {
      const logsPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:_garden-logs`);
      if (logsPaneId) disablePaneInput(logsPaneId);
    } catch { /* window doesn't exist */ }

    return;
  }

  truncateLog();
  log.info("dashboard", "creating new dashboard");
  // Preserve the previous activePlot across dashboard recreation so a user
  // who ran `garden plot imp` before launching the dashboard lands on imp.
  const priorActivePlot = readDashState().activePlot;
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }

  const gardenRunner = resolveGardenRunner();
  const cwd = process.cwd();
  const statusCmd = buildStatusCommand(gardenRunner);

  const config = loadConfig();
  const initialActivePlot =
    (priorActivePlot && plotNames(config).includes(priorActivePlot) ? priorActivePlot : null) ??
    firstFocusedPlotName(config);
  const focusedNames = getFocusedProjectNames(config, initialActivePlot);
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

  // The fresh server inherited this process's env, but set-environment makes
  // the provider keys survive server-env quirks and later config edits.
  syncAllProviderTokens(config);

  tmux("set-option", "-t", DASHBOARD_SESSION, "set-titles", "on");
  tmux("set-option", "-t", DASHBOARD_SESSION, "set-titles-string", "garden");
  // Large scrollback for every pane; default 2000 is tiny for worker Claude output.
  tmux("set-option", "-t", DASHBOARD_SESSION, "history-limit", "1000000");

  const gardenShellId = tmuxOutput(
    "display-message", "-t", `${DASHBOARD_SESSION}:main.0`, "-p", "#{pane_id}");

  const rightPaneId = tmuxSplit("-h", "-t", `${DASHBOARD_SESSION}:main.0`, "-c", firstPath, "-l", "60%");

  const statusId = tmuxSplit("-v", "-b", "-t", gardenShellId, "-l", String(statusHeight),
    "sh", "-c", statusCmd);

  try { tmux("resize-pane", "-t", statusId, "-y", String(statusHeight)); } catch { /* ignore */ }
  try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }

  const usageCmd = buildUsageCommand(gardenRunner);
  const usageId = tmuxSplit("-v", "-b", "-t", statusId, "-l", String(USAGE_PANE_HEIGHT),
    "sh", "-c", usageCmd);
  try { tmux("resize-pane", "-t", usageId, "-y", String(USAGE_PANE_HEIGHT)); } catch { /* ignore */ }
  try { tmux("clear-history", "-t", usageId); } catch { /* ignore */ }
  // Splitting shrinks status pane — flush the ghost rows pushed into scrollback by the resize.
  try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }

  setPaneTitle(usageId, "garden");
  setPaneLabel(usageId, "#[fg=green,bold]garden#[default] 🌱");
  setPaneTitle(statusId, "status");
  // @garden_name is overwritten by updateHeaderVar() with the plot strip; leave it unset here.
  setPaneTitle(gardenShellId, "growhouse");
  setPaneLabel(gardenShellId, "growhouse");
  disablePaneInput(usageId);
  disablePaneInput(statusId);
  lockPaneMouse(usageId);
  lockPaneMouse(statusId);
  if (firstProject) {
    setPaneLabel(rightPaneId, `shell-${firstProject}`);
    setPaneTitle(rightPaneId, firstProject);
  }

  // Clear scrollback created by resize events during split setup
  try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }

  const growhouseInit = writeGrowhouseInitScript(gardenRunner);
  tmux("send-keys", "-t", gardenShellId, `source ${shellEscape(growhouseInit)} && clear`, "Enter");

  setupStatusBar(gardenRunner);

  // tmux pane-died hook: when a worker pane process exits, write
  // agentStatus="exited" to the registry. This is the only mechanism in
  // the new status model that observes process liveness — and tmux delivers
  // it as an event, not a poll.
  // gardenRunner is already pre-escaped per token by resolveGardenRunner();
  // wrap the inner shell command with tmuxDoubleQuote so $, `, and \ in the
  // runner path don't get re-interpreted by tmux's command parser.
  // `#{window_name}` stays unescaped so tmux still expands the format ref.
  try {
    const inner = `${gardenRunner} dashboard _pane-died '#{window_name}' 2>/dev/null`;
    tmux("set-hook", "-t", DASHBOARD_SESSION, "pane-died",
      `run-shell ${tmuxDoubleQuote(inner)}`);
  } catch { /* hooks may not be supported on very old tmux */ }

  // tmux pane-title-changed hook: Claude Code sets the pane title via escape
  // sequences as it works. This hook captures those changes live so task
  // summaries in the status pane and pane border stay current without polling.
  try {
    const inner = `${gardenRunner} dashboard _title-changed '#{window_name}' '#{pane_id}' 2>/dev/null`;
    tmux("set-hook", "-t", DASHBOARD_SESSION, "pane-title-changed",
      `run-shell -b ${tmuxDoubleQuote(inner)}`);
  } catch { /* hooks may not be supported on very old tmux */ }

  // Re-bake pane content + re-pin heights on terminal resize (see reattach path for rationale).
  try {
    const inner = `${gardenRunner} dashboard _client-resized 2>/dev/null`;
    tmux("set-hook", "-t", DASHBOARD_SESSION, "client-resized",
      `run-shell -b ${tmuxDoubleQuote(inner)}`);
  } catch { /* hooks may not be supported on very old tmux */ }

  const state: DashboardState = {
    activeProject: firstProject,
    activePlot: initialActivePlot,
    statusPaneId: statusId,
    usagePaneId: usageId,
    gardenShellPaneId: gardenShellId,
    gardenPaneType: "growhouse",
    gardenWindowName: gardenWindowName("growhouse"),
    alertsSeenMark: null,
    activePaneId: rightPaneId,
    activePaneType: firstProject ? "shell" : null,
    activeWindowName: firstProject ? shellWin(firstProject) : null,
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
    // Computed by the watchdog's first staleness tick.
    buildBehind: null,
  };

  writeDashState(state);
  updateHeaderVar();
  installInputGuard(state);

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

    for (const entry of entries) {
      if (!entry.sessionId) continue;
      // Capture mid-turn interruption before we overwrite agentStatus below.
      // pane-died sets interruptedWhileWorking when agentStatus was "working"
      // at exit; if pane-died never fired (tmux server crash), agentStatus
      // itself will still be "working".
      // SessionStart DOES fire on --resume (source="resume"), but the hook now
      // preserves whatever we write here rather than resetting it (see
      // hooks/default.ts) — so this write is the authoritative post-resume
      // status. resolveResumeAgentStatus parks an interrupted worker at the
      // "ready" cold-start sentinel the continue-retry watches, keeps an
      // operator hold / pending question across the rebuild, and returns
      // everything else to "idle" at the prompt (never the one-time "ready").
      // prState is preserved as-is from the previous session.
      const resumeStatus = resolveResumeAgentStatus(entry);
      const wasInterrupted = resumeStatus === "ready";
      updateWorkerFields(projectName, entry.name, { agentStatus: resumeStatus });
      const workerWindowName = respawnWorkerWindow(projectName, projectConfig, entry, rightSize);
      if (!workerWindowName) continue;

      if (projectName === state.activeProject && !firstResumedWindow) {
        firstResumedWindow = workerWindowName;
      }

      if (wasInterrupted) {
        dispatchDelayedContinue(gardenRunner, projectName, entry.name);
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
  startWatchdog(gardenRunner);

  if (firstResumedWindow && state.activePaneId) {
    tmux("select-pane", "-t", state.activePaneId);
  } else {
    tmux("select-pane", "-t", gardenShellId);
  }
}

export function createLogsWindow(): void {
  const windowName = gardenWindowName("logs");
  const scriptFile = writeLogsScript();

  newDashboardWindow(windowName, "sh", "-c", `sh ${shellEscape(scriptFile)}`);

  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, formatLogsPaneLabel());
    setPaneTitle(paneId, "logs");
    disablePaneInput(paneId);
  }
}

function writeLogsScript(): string {
  const scriptFile = path.join(SESSIONS_DIR, "logs-view.sh");

  // Use garden logs --follow for live-tailing with pretty formatting.
  // GARDEN_PRETTY=1 forces TTY-style color output inside the tmux pane.
  // --count 5000 overrides the CLI default of 40 — for the dashboard pane we
  // want the initial dump to fill scrollback (history-limit is 1,000,000
  // lines), so the operator can scroll back through hours of activity. The
  // CLI default stays at 40 to keep one-shot `garden logs` terse.
  const script = `#!/bin/sh
export GARDEN_PRETTY=1
exec garden logs --follow --count 5000
`;

  // Atomic so a tmux respawn-pane reading this file mid-write doesn't see a
  // truncated script — a partial #!/bin/sh + missing exec line just hangs.
  atomicWriteFile(scriptFile, script, { mode: 0o755 });
  return scriptFile;
}

export function createGardenGrowhouseWindow(gardenRunner: string): void {
  const growhouseInit = writeGrowhouseInitScript(gardenRunner);
  const windowName = gardenWindowName("growhouse");
  newDashboardWindow(windowName);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "growhouse");
    setPaneTitle(paneId, "growhouse");
    tmux("send-keys", "-t", paneId, `source ${shellEscape(growhouseInit)} && clear`, "Enter");
  }
}

export function createGardenRootWindow(): void {
  const windowName = gardenWindowName("root");
  newDashboardWindow(windowName);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "root");
    setPaneTitle(paneId, "root");
  }
}

// History view (⌥h): a passive SIGUSR1 repaint pane, same shape as the usage
// pane. writeHistoryRendered fills history.rendered with the focused worker's
// prompt history (parsed from its conversation transcript).
export function createGardenHistoryWindow(gardenRunner: string): void {
  const windowName = gardenWindowName("history");
  const cmd = buildHistoryCommand(gardenRunner);
  newDashboardWindow(windowName, "sh", "-c", cmd);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "history");
    setPaneTitle(paneId, "history");
    disablePaneInput(paneId);
  }
}

// Alerts view (⌥a): a passive SIGUSR1 repaint pane, same shape as the history
// pane. writeAlertsRendered fills alerts.rendered with the unread/read alert
// list. Focusing this view is also what marks alerts read (see focusAlerts).
export function createGardenAlertsWindow(gardenRunner: string): void {
  const windowName = gardenWindowName("alerts");
  newDashboardWindow(windowName, "sh", "-c", buildAlertsCommand(gardenRunner));
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "alerts");
    setPaneTitle(paneId, "alerts");
    disablePaneInput(paneId);
  }
}

// Diary view (⌥d): the focused project's diary open in $EDITOR. The
// wrapper loop re-resolves the focused project each time the editor exits,
// so quitting the editor after a project switch reopens on the new diary.
export function createGardenDiaryWindow(gardenRunner: string): void {
  const scriptFile = writeDiaryViewScript(gardenRunner);
  const windowName = gardenWindowName("diary");
  newDashboardWindow(windowName, "sh", "-c", `sh ${shellEscape(scriptFile)}`);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "diary");
    setPaneTitle(paneId, "diary");
  }
}

function writeDiaryViewScript(gardenRunner: string): string {
  // gardenRunner is pre-escaped per token by resolveGardenRunner(), so it
  // interpolates raw (see writeGrowhouseInitScript). $EDITOR stays unquoted
  // so multi-word values ("code -w") split into command + args. The fallback
  // is nano (ships with macOS, self-documenting save/exit hints) rather than
  // vi, so an unset $EDITOR gives a friendly modeless editor out of the box.
  // nano/pico get -b to enable word wrap so long diary lines wrap to the pane
  // width instead of scrolling off the right edge.
  const script = `#!/bin/sh
# Garden diary view — edits the focused project's diary in $EDITOR.
while :; do
  f="$(${gardenRunner} dashboard _diary-path 2>/dev/null)"
  if [ -z "$f" ]; then
    clear
    echo "No focused project. Select one (Alt-1..9) and the diary reopens."
    sleep 2
    continue
  fi
  ed="\${EDITOR:-nano}"
  bin="\${ed%% *}"
  bin="\${bin##*/}"
  wrap=""
  case "$bin" in
    nano|pico) wrap="-b" ;;
  esac
  $ed $wrap "$f" || sleep 1
done
`;
  const scriptFile = path.join(SESSIONS_DIR, "diary-view.sh");
  atomicWriteFile(scriptFile, script, { mode: 0o755 });
  return scriptFile;
}

export function createShellWindow(projectName: string, projectPath: string): void {
  const windowName = shellWin(projectName);
  newDashboardWindow(windowName, "-c", projectPath);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, `shell-${projectName}`);
    setPaneTitle(paneId, projectName);
    // The right-pane shell shows the same wall clock as worker panes.
    setPaneVar(paneId, "garden_clock", "1");
    setPaneProjectColor(paneId, projectName);
  }
}

export function buildWorkerCommand(projectName: string, projectPath: string, sessionId: string): string {
  const project = resolveProjectForHooks(projectName, projectPath);
  const harness = getHarness();
  harness.installRuntimeConfig(projectPath, project);
  const gardenRunner = resolveGardenRunner();
  const contextFile = writeContextFile(projectName, projectPath);
  const agentCmd = harness.buildAgentCommand({
    sessionId, resume: false, contextFile, envPrefix: workerEnvPrefix(project),
  });
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${agentCmd}; ${exitHook}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

export function buildResumeCommand(projectName: string, projectPath: string, sessionId: string): string {
  const project = resolveProjectForHooks(projectName, projectPath);
  const harness = getHarness();
  harness.installRuntimeConfig(projectPath, project);
  const gardenRunner = resolveGardenRunner();
  const contextFile = writeContextFile(projectName, projectPath);
  const agentCmd = harness.buildAgentCommand({
    sessionId, resume: true, contextFile, envPrefix: workerEnvPrefix(project),
  });
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${agentCmd}; ${exitHook}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

// The selectable reasoning-effort rungs below the ultracode preset. These are
// claude-code's `--effort` levels; the top rung (max effort + dynamic
// workflows) is the ultracode preset, offered in the composer as "ultra" and
// carried by `WorkerEntry.ultracode`, not an effort value here. The composer
// effort submenu and the `--effort` CLI flag build their choices from this
// list plus the "ultra" sentinel.
export const WORKER_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type WorkerEffort = (typeof WORKER_EFFORT_LEVELS)[number];

export function isWorkerEffort(value: string): value is WorkerEffort {
  return (WORKER_EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface WorktreeCommandOptions {
  /** Worktree-relative path to the trellis file. When set,
   *  buildWorktreeRules appends the three trellis paragraphs to the
   *  worker's system prompt. Default workers omit this and get the
   *  baseline rules. */
  trellisRelativePath?: string;
  /** When set, buildWorktreeRules appends the three grow paragraphs
   *  (Concept / Bias / Termination) referencing the iteration count.
   *  Mutually exclusive with `trellisRelativePath` — a worker is one
   *  workflow at a time. */
  grow?: {
    iteration: number;
    maxIterations: number;
  };
  /** Model to pass to claude via `--model` in the bootstrap/respawn/resume
   *  invocation. When set, the launched claude process is pinned to that
   *  model. When unset, claude uses the account default and no `--model`
   *  flag is passed. Opaque string: an Anthropic alias or any concrete
   *  model id the backend accepts. Default/grow workers thread the
   *  persisted `entry.model`; trellis vines resolve per iteration
   *  (per-worker `trellis.workerModel` override + the Sonnet exhaustion
   *  fallback via `resolveVineModel`). */
  model?: string;
  /** Ultracode preset (`WorkerEntry.ultracode`). When set, the launched
   *  claude gets `--effort max` plus the dynamic-workflow keyword trigger.
   *  Threaded from the entry through spawn/resume/bounce so the mode
   *  survives the worker's lifetime. The paired Opus pin travels via
   *  `model`. */
  ultracode?: boolean;
  /** Per-worker reasoning effort (`WorkerEntry.effort`), in the target
   *  harness's own vocabulary — claude-code takes WORKER_EFFORT_LEVELS and
   *  renders `--effort <level>`; codex takes CODEX_EFFORT_LEVELS and renders
   *  `-c model_reasoning_effort=<level>`. The two ladders overlap on
   *  low/medium/high/xhigh but are not the same list, so the composer offers
   *  the chosen harness's own rungs. Independent of `model`: "extra-high
   *  sonnet" is `model: sonnet` + `effort: xhigh`. On claude-code the top rung
   *  (max effort + dynamic workflows) is the `ultracode` preset, not an effort
   *  value, so effort and ultracode never co-occur; buildAgentCommand lets
   *  ultracode win if both are somehow set. Codex has no ultracode analog and
   *  ignores that flag — but its own "ultra" reasoning level is a plain effort
   *  value that passes straight through. */
  effort?: string;
  /** Per-worker provider backend (`WorkerEntry.provider`) — the axis-1 half
   *  of the build member, overriding the project's `provider` key for this
   *  worker's launch env. Absent = the project key applies, so the common case
   *  threads nothing; the empty string means explicitly first-party (see
   *  workerProject). Threaded by resume/bounce/loop callers from the entry so
   *  the backend survives the worker's lifetime, exactly like `model`. */
  provider?: string;
  /** Harness adapter name (`WorkerEntry.harness`). Absent = the default
   *  claude-code adapter. Threaded by resume/bounce/loop callers from the
   *  entry; spawn-time selection arrives with the second adapter. */
  harness?: string;
  /** When set, buildWorktreeRules inverts the worktree posture for a botanist
   *  (design) worker and suppresses the checks paragraph. Threaded from the
   *  spawn (workflow === "botanist") and re-derived on resume/bounce from
   *  `entry.workflow` so the inversion survives the worker's lifetime.
   *  Mutually exclusive with `trellisRelativePath` / `grow`. */
  botanist?: boolean;
}

export function buildWorktreeWorkerCommand(
  projectName: string,
  projectPath: string,
  workerName: string,
  branchName: string,
  sessionId: string,
  baseBranch?: string,
  opts?: WorktreeCommandOptions,
): string {
  const contextFile = writeWorktreeContextFile(
    projectName, projectPath, branchName, baseBranch,
    { trellisRelativePath: opts?.trellisRelativePath, grow: opts?.grow, botanist: opts?.botanist },
  );
  const project = resolveProjectForHooks(projectName, projectPath);
  const agentCmd = getHarness(opts?.harness).buildAgentCommand({
    sessionId, resume: false, contextFile, model: opts?.model,
    ultracode: opts?.ultracode, effort: opts?.effort, envPrefix: workerEnvPrefix(workerProject(project, opts?.provider)),
    worktreeGitDir: codexWorktreeGitDir(opts?.harness, projectPath),
  });
  return `${agentCmd}; ${pollSignalSnippet(projectName)} exec $SHELL`;
}

// The project view a WORKER's runtime is built from: the real project with its
// provider replaced by the worker's own, when that worker carries a per-worker
// override (its build member named a backend). Absent override = the project
// unchanged, so every pre-existing launch path is byte-identical.
// Both halves of the worker's runtime read through this — the launch env
// (workerEnvPrefix) and the sandbox egress allowlist (buildSandboxConfig, which
// admits the provider's inference host) — so a worker cannot end up pointed at
// one backend while its sandbox admits another. Only the worker role consults
// it: reviewerEnvPrefix deliberately reads the project, since the review family
// stays first-party by construction.
export function workerProject<T extends { provider?: string }>(project: T, provider: string | undefined): T {
  // undefined = no per-worker answer, inherit the project (the pre-existing
  // path, byte-identical). A non-empty string = this worker's backend. The
  // EMPTY string is the explicit-first-party marker newWorker stamps for a
  // member that named no provider — it must clear the project's, not fall
  // through to it, or "claude" on a provider-backed project would silently
  // launch against the provider anyway.
  if (provider === undefined) return project;
  return { ...project, provider: provider || undefined };
}

// The worktree git common dir a Codex worker's sandbox must be able to write
// (its git store sits outside the worktree cwd — see AgentCommandOptions
// .worktreeGitDir). Resolved from the project's main checkout so it works
// before the worktree exists; only for the codex harness (skips the git spawn
// on the hot claude-code path). Other harnesses ignore the field.
function codexWorktreeGitDir(harness: string | undefined, projectPath: string): string | undefined {
  return harness === "codex" ? (getGitCommonDir(projectPath) ?? undefined) : undefined;
}

// Resolve a ProjectConfig for the harness adapter installRuntimeConfig calls. Callers of buildWorkerCommand
// only carry a name and path (pre-worktree API shape), so look up the registered
// project when possible and fall back to a minimal stub for unknown projects
// (e.g., tests or ad-hoc invocations).
function resolveProjectForHooks(projectName: string, projectPath: string): ProjectConfig {
  const registered = tryGetProject(projectName);
  return registered ?? { path: projectPath };
}

// Compute the worktree-relative trellis path for a worker entry, suitable
// for buildWorktreeRules's trellis option. Returns undefined for default
// workers and trellis workers without a stored trellis.path. The trellis
// file lives at the same project-relative path inside the worktree
// (worktrees share the project's working tree layout post-rebase), so
// this is a path-prefix swap from project-rooted to worktree-rooted.
export function trellisRelativePathForEntry(
  entry: { workflow?: string; trellis?: { path?: string }; worktreePath?: string },
  projectPath: string,
): string | undefined {
  if (entry.workflow !== "trellis") return undefined;
  const tPath = entry.trellis?.path;
  if (!tPath) return undefined;
  const projectPrefix = projectPath.endsWith(path.sep) ? projectPath : projectPath + path.sep;
  if (tPath.startsWith(projectPrefix)) {
    return tPath.slice(projectPrefix.length);
  }
  // Trellis lives outside the project tree (unusual). Fall back to absolute.
  return tPath;
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
  opts?: WorktreeCommandOptions,
): string {
  // Write the context file eagerly (fast, just file I/O)
  const contextFile = writeWorktreeContextFile(
    projectName, projectPath, branchName, baseBranch,
    { trellisRelativePath: opts?.trellisRelativePath, grow: opts?.grow, botanist: opts?.botanist },
  );

  const fifoLit = shellEscape(signalFifoPath(projectName));
  const pollSignal = `[ -p ${fifoLit} ] && (echo > ${fifoLit}) 2>/dev/null;`;

  const projectPathLit = shellEscape(projectPath);
  const wtPathLit = shellEscape(wtPath);
  const hooksDirLit = shellEscape(path.join(wtPath, ".garden-hooks"));
  const hookPathLit = shellEscape(path.join(wtPath, ".garden-hooks", "pre-push"));
  const signalFifoPath_ = path.join(SESSIONS_DIR, `${projectName}-poll-signal`);

  // Build the hook script content with the actual fifo path baked in. Joined
  // with literal "\n" (two characters) — the outer printf at install time
  // interprets them as newlines.
  const hookContent = [
    "#!/bin/sh",
    `FIFO=${shellEscape(signalFifoPath_)}`,
    'if [ -p "$FIFO" ]; then',
    '  (echo > "$FIFO") </dev/null >/dev/null 2>&1 &',
    'fi',
    'exit 0',
  ].join("\\n");

  const gardenRunner = resolveGardenRunner();
  // gardenRunner arrives pre-escaped from resolveGardenRunner() — each token
  // (interpreter + script path) is individually shellEscape'd. Re-wrapping
  // would single-quote the whole multi-token string.
  const gardenRunnerLit = gardenRunner;
  const project = resolveProjectForHooks(projectName, projectPath);
  // The bootstrap inlines the Claude Code runtime config in shell form
  // (settings.json + skills layout below) — this whole script is the
  // claude-code dialect today. A second harness adds an adapter method
  // that renders its own bootstrap config section (docs/MULTI-MODEL.md
  // "Layer 3"); until then the adapter's internals are imported directly.
  // Same project view the launch env below is built from: a worker whose build
  // member named a backend must get that backend's inference host in its egress
  // allowlist, not the project's.
  const settingsJson = buildSettingsJson(resolveHookRunner(), buildSandboxConfig({
    worktreePath: wtPath,
    project: workerProject(project, opts?.provider),
    remoteHost: getRemoteHost(project.path),
  }));
  const settingsJsonLit = shellEscape(settingsJson);
  const doneSkillLit = shellEscape(DONE_SKILL_CONTENT);
  const doneSkillDirnameLit = shellEscape(DONE_SKILL_DIRNAME);
  const doneSkillFilenameLit = shellEscape(DONE_SKILL_FILENAME);
  const handoffSkillLit = shellEscape(HANDOFF_SKILL_CONTENT);
  const handoffSkillDirnameLit = shellEscape(HANDOFF_SKILL_DIRNAME);
  const handoffSkillFilenameLit = shellEscape(HANDOFF_SKILL_FILENAME);
  const trellisAuthorSkillLit = shellEscape(TRELLIS_AUTHOR_SKILL_CONTENT);
  const trellisAuthorSkillDirnameLit = shellEscape(TRELLIS_AUTHOR_SKILL_DIRNAME);
  const trellisAuthorSkillFilenameLit = shellEscape(TRELLIS_AUTHOR_SKILL_FILENAME);
  const growSkillLit = shellEscape(GROW_SKILL_CONTENT);
  const growSkillDirnameLit = shellEscape(GROW_SKILL_DIRNAME);
  const growSkillFilenameLit = shellEscape(GROW_SKILL_FILENAME);
  const botanistSkillLit = shellEscape(BOTANIST_SKILL_CONTENT);
  const botanistSkillDirnameLit = shellEscape(BOTANIST_SKILL_DIRNAME);
  const botanistSkillFilenameLit = shellEscape(BOTANIST_SKILL_FILENAME);
  const agentCmd = getHarness(opts?.harness).buildAgentCommand({
    sessionId, resume: false, contextFile, model: opts?.model,
    ultracode: opts?.ultracode, effort: opts?.effort, envPrefix: workerEnvPrefix(workerProject(project, opts?.provider)),
    worktreeGitDir: codexWorktreeGitDir(opts?.harness, projectPath),
  });

  const base = baseBranch ?? "main";
  const baseLit = shellEscape(base);
  const projectNameLit = shellEscape(projectName);
  const branchLit = shellEscape(branchName);
  const workerLit = shellEscape(workerName);

  // The inline config below is the claude-code dialect (.claude/settings.json +
  // skills). For a Codex worker it is inert (Codex ignores .claude/), so rather
  // than fork the whole bootstrap we leave it and ADD the Codex runtime after
  // worktree setup: .codex/hooks.json + directory-trust + the composed rules as
  // AGENTS.md, installed by the _install-worker-runtime subcommand (reuses the
  // adapter's TS, no fragile shell-gen). Empty string for claude keeps the
  // generated script byte-identical to today.
  const contextFileLit = shellEscape(contextFile);
  const codexRuntimeInstall = opts?.harness === "codex"
    ? `\n# Install the Codex worker runtime the inline claude config above omits.\n`
      + `${gardenRunnerLit} dashboard _install-worker-runtime ${projectNameLit} ${workerLit} ${contextFileLit} 2>/dev/null || true\n`
    : "";

  const script = `#!/bin/sh
set -e

# Any unhandled non-zero exit keeps the pane alive — exit 1 would let tmux
# close the right-slot pane and wedge every subsequent park/swap (the
# dashboard layout invariant requires the right slot to stay alive). The
# trap fires before set -e exits, so the operator sees the error and can
# close the pane via ⌥x. exec replaces this script with a shell, so the
# trap doesn't recurse when that shell eventually exits.
trap '_rc=$?; printf "\\n  Bootstrap aborted unexpectedly (exit %s). Press ⌥x to close this pane.\\n" "$_rc" >&2; trap - ERR EXIT; exec $SHELL' ERR

# Initial base resolved from the operator's main-checkout HEAD. May be
# rewritten below when that branch turns out to be missing on origin (the
# operator merged a PR and deleted the branch). Workers downstream of this
# script read GARDEN_BASE_BRANCH via env, so re-export after any fallback.
BASE=${baseLit}
ORIG_BASE=${baseLit}
export GARDEN_PROJECT=${projectNameLit}
export GARDEN_WORKER=${workerLit}
export GARDEN_BRANCH=${branchLit}
export GARDEN_BASE_BRANCH="$BASE"
${beadsEnvExports(projectName, workerName)}

# Atomically write stdin to a destination via tmp+rename so concurrent readers
# (Claude on SessionStart / --resume reading .claude/settings.json) never see
# a partial file.
atomic_write() {
  _aw_dest="$1"
  _aw_tmp="\${_aw_dest}.tmp.$$"
  cat > "$_aw_tmp" && mv "$_aw_tmp" "$_aw_dest"
}

printf 'Setting up worktree %s...\\n' ${branchLit}

# Fetch latest base ref. Worker always branches off origin/$BASE directly
# (see "git worktree add" below), so main-checkout freshness is informational
# only — but a stale main checkout signals operator rot and deserves an alert.
printf '  Fetching origin/%s...\\n' "$BASE"
BOOTSTRAP_FAIL=""
FETCH_RC=0
FETCH_OUT=$(git -C ${projectPathLit} fetch origin "$BASE" 2>&1) || FETCH_RC=$?
[ -n "$FETCH_OUT" ] && printf '%s\\n' "$FETCH_OUT"
if [ "$FETCH_RC" -ne 0 ]; then
  BOOTSTRAP_FAIL="fetch failed: $FETCH_OUT"
  # Fetch failed. If ls-remote ALSO fails, the branch is genuinely gone from
  # origin (typical cause: operator merged the PR on GitHub and deleted the
  # branch, leaving the main checkout parked on a now-dead ref). In that case,
  # fall back to origin's default branch — discovered via "ls-remote --symref
  # origin HEAD" — rather than dying mid-bootstrap. Transient network errors
  # are still tolerated: if ls-remote SUCCEEDS, we proceed with the local ref.
  LS_RC=0
  LS_OUT=$(git -C ${projectPathLit} ls-remote --exit-code --heads origin "$BASE" 2>&1) || LS_RC=$?
  if [ "$LS_RC" -ne 0 ]; then
    printf '  WARNING: origin has no branch %s — looking up origin default branch...\\n' "$BASE" >&2
    DEFAULT_BRANCH=$(git -C ${projectPathLit} ls-remote --symref origin HEAD 2>/dev/null \\
      | sed -n 's|^ref: refs/heads/\\([^	]*\\)	HEAD|\\1|p' \\
      | head -1)
    if [ -n "$DEFAULT_BRANCH" ] && [ "$DEFAULT_BRANCH" != "$BASE" ] \\
        && git -C ${projectPathLit} ls-remote --exit-code --heads origin "$DEFAULT_BRANCH" >/dev/null 2>&1; then
      printf '  Falling back to origin default: %s.\\n' "$DEFAULT_BRANCH" >&2
      # Update registry baseBranch so the poller, reviewer, and Stop hook all
      # see the new base. Do this BEFORE re-fetching so a subsequent crash
      # leaves a coherent entry.
      ${gardenRunnerLit} dashboard _bootstrap-rebase ${projectNameLit} ${workerLit} "$DEFAULT_BRANCH" "$ORIG_BASE" 2>/dev/null || true
      # Prune stale local ref so future workers don't fall into the same trap.
      git -C ${projectPathLit} update-ref -d "refs/remotes/origin/$ORIG_BASE" 2>/dev/null || true
      BASE="$DEFAULT_BRANCH"
      export GARDEN_BASE_BRANCH="$BASE"
      BOOTSTRAP_FAIL=""
      FETCH_RC=0
      FETCH_OUT=$(git -C ${projectPathLit} fetch origin "$BASE" 2>&1) || FETCH_RC=$?
      [ -n "$FETCH_OUT" ] && printf '%s\\n' "$FETCH_OUT"
      if [ "$FETCH_RC" -ne 0 ]; then
        BOOTSTRAP_FAIL="fetch failed after fallback: $FETCH_OUT"
      fi
    else
      printf '  ERROR: origin has no branch %s and cannot resolve origin HEAD.\\n' "$BASE" >&2
      printf '%s\\n' "$LS_OUT" >&2
      ${gardenRunnerLit} dashboard _bootstrap-fail ${projectNameLit} ${workerLit} "base $ORIG_BASE missing on origin and origin/HEAD unresolved" 2>/dev/null || true
      # Keep the pane alive — exit 1 would close it and tmux would destroy the
      # right-slot pane, leaving state.activePaneId stale and wedging every
      # subsequent park/swap. exec a shell so the operator sees the error and
      # closes the pane via ⌥x.
      printf '\\n  Press ⌥x to close this pane.\\n' >&2
      exec $SHELL
    fi
  fi
fi

printf '  Fast-forwarding main checkout...\\n'
MERGE_RC=0
MERGE_OUT=$(git -C ${projectPathLit} merge --ff-only "origin/$BASE" 2>&1) || MERGE_RC=$?
[ -n "$MERGE_OUT" ] && printf '%s\\n' "$MERGE_OUT"
if [ "$MERGE_RC" -ne 0 ]; then
  BOOTSTRAP_FAIL="\${BOOTSTRAP_FAIL:+$BOOTSTRAP_FAIL; }ff-merge failed: $MERGE_OUT"
fi

if [ -n "$BOOTSTRAP_FAIL" ]; then
  printf '  WARNING: main checkout did not update cleanly — raising alert.\\n' >&2
  ${gardenRunnerLit} dashboard _bootstrap-alert ${projectNameLit} "$BASE" ${projectPathLit} "$BOOTSTRAP_FAIL" 2>/dev/null || true
fi

# Create worktree. Branch explicitly off origin/$BASE so worker freshness
# does not depend on the main checkout being clean or up to date.
printf '  Creating worktree...\\n'
mkdir -p "$(dirname ${wtPathLit})"
git -C ${projectPathLit} worktree add ${wtPathLit} -b ${branchLit} "origin/$BASE"

# Neutralize .garden-done if a past reviewer accidentally committed it to the
# base branch. Without this, the first Stop hook with no commits ahead sees
# isDoneSet=true and trips terminal "done"; and even after UserPromptSubmit
# clears the file, a routine \`git checkout HEAD -- .garden-done\` resurrects
# it (this is exactly how wolf/swift-trim-knoll wedged on 2026-05-10). The
# update-index bit keeps \`git status\` clean AND causes path-scoped checkouts
# from HEAD to error rather than restore. The operator should still
# \`git rm .garden-done\` on the project's main; this only de-fangs each new
# worker until that cleanup lands.
if git -C ${wtPathLit} ls-tree HEAD .garden-done 2>/dev/null | grep -q '\\.garden-done'; then
  printf '  WARNING: .garden-done is tracked in HEAD of %s — neutralizing in this worktree. Run \`git rm .garden-done\` on the project main to fix at the root.\\n' ${projectNameLit} >&2
  git -C ${wtPathLit} update-index --skip-worktree .garden-done 2>/dev/null || true
  rm -f ${wtPathLit}/.garden-done
fi

# Install dependencies if needed
if [ -f ${wtPathLit}/package.json ]; then
  printf '  Installing dependencies...\\n'
  (cd ${wtPathLit} && npm install --prefer-offline) 2>/dev/null || true
fi
if [ -f ${wtPathLit}/pyproject.toml ] && grep -q '\\[tool.poetry\\]' ${wtPathLit}/pyproject.toml 2>/dev/null; then
  printf '  Installing poetry deps...\\n'
  (cd ${wtPathLit} && poetry install --no-interaction) 2>/dev/null || true
fi

# Install poll trigger hook. Scope core.hooksPath to THIS worktree only:
# a plain --local write leaks into the shared .git/config, so the main checkout
# would run this sandbox-writable hook unsandboxed and the operator's own hooks
# go dormant (see scopeHooksPathToWorktree in git.ts). Enable worktree config,
# clear a garden-owned leak in the shared config (operator values untouched),
# then write in --worktree scope.
mkdir -p ${hooksDirLit}
printf '${hookContent}\\n' | atomic_write ${hookPathLit}
chmod 755 ${hookPathLit}
git -C ${wtPathLit} config extensions.worktreeConfig true
_gh_leaked=$(git -C ${wtPathLit} config --local --get core.hooksPath 2>/dev/null || true)
case "$_gh_leaked" in *.garden-hooks) git -C ${wtPathLit} config --local --unset core.hooksPath 2>/dev/null || true ;; esac
git -C ${wtPathLit} config --worktree core.hooksPath ${hooksDirLit}

# Install Claude Code hooks — settings.json (not .local.json, which Claude Code auto-edits and would clobber).
# chmod 444: defense-in-depth so an agent can't trivially edit its own
# sandbox without first chmod'ing — installRuntimeConfig rewrites this on
# every refresh/bounce anyway, so tampering doesn't survive long.
mkdir -p ${wtPathLit}/.claude
printf '%s' ${settingsJsonLit} | atomic_write ${wtPathLit}/.claude/settings.json
chmod 444 ${wtPathLit}/.claude/settings.json

# Install garden-bundled skills (see src/dashboard/skills.ts). Layout: .claude/skills/<name>/SKILL.md.
mkdir -p ${wtPathLit}/.claude/skills/${doneSkillDirnameLit}
printf '%s' ${doneSkillLit} | atomic_write ${wtPathLit}/.claude/skills/${doneSkillDirnameLit}/${doneSkillFilenameLit}
mkdir -p ${wtPathLit}/.claude/skills/${handoffSkillDirnameLit}
printf '%s' ${handoffSkillLit} | atomic_write ${wtPathLit}/.claude/skills/${handoffSkillDirnameLit}/${handoffSkillFilenameLit}
mkdir -p ${wtPathLit}/.claude/skills/${trellisAuthorSkillDirnameLit}
printf '%s' ${trellisAuthorSkillLit} | atomic_write ${wtPathLit}/.claude/skills/${trellisAuthorSkillDirnameLit}/${trellisAuthorSkillFilenameLit}
mkdir -p ${wtPathLit}/.claude/skills/${growSkillDirnameLit}
printf '%s' ${growSkillLit} | atomic_write ${wtPathLit}/.claude/skills/${growSkillDirnameLit}/${growSkillFilenameLit}
mkdir -p ${wtPathLit}/.claude/skills/${botanistSkillDirnameLit}
printf '%s' ${botanistSkillLit} | atomic_write ${wtPathLit}/.claude/skills/${botanistSkillDirnameLit}/${botanistSkillFilenameLit}

# Ensure garden-managed dirs are excluded from git status.
# Writing to the common info/exclude covers all worktrees and never gets committed.
# .garden/ covers per-worker artifacts (grow-goal.md, grow-log.md,
# trellis-lessons.md) — none of these belong in version control. .garden-done
# is the auto-continue suppression sentinel; the done skill description
# advertises this exclusion as the reason workers should not \`git add\` it.
# .garden-awaiting-input is the human-gate sentinel (botanist/plan), excluded
# for the same reason.
EXCLUDE_FILE="$(git -C ${wtPathLit} rev-parse --git-common-dir)/info/exclude"
for pattern in .claude/ .garden-hooks/ .garden/ .garden-done .garden-awaiting-input; do
  grep -qxF "$pattern" "$EXCLUDE_FILE" 2>/dev/null || printf '%s\\n' "$pattern" >> "$EXCLUDE_FILE"
done
${codexRuntimeInstall}
# Switch to the worktree directory
cd ${wtPathLit}
printf '  Ready.\\n\\n'

# Launch the agent
${agentCmd}
${gardenRunnerLit} dashboard _claude-hook stop 2>/dev/null || true
${pollSignal}
exec $SHELL
`;

  const scriptFile = path.join(SESSIONS_DIR, `bootstrap-${projectName}-${branchName}.sh`);
  // Bootstrap script is read by the worker pane's `sh` immediately after
  // it's written. Atomic write so the read can't catch a half-written file.
  atomicWriteFile(scriptFile, script, { mode: 0o755 });
  return scriptFile;
}

// Recreate one worker's hidden window and resume its agent session in it —
// the per-entry core of ensureDashboard's attach-time resume loop, shared
// with `garden resurrect` (which rebuilds a killed worker from its telemetry
// tombstone and then needs exactly this respawn). Installs the worktree's
// runtime config (hook settings + sandbox, poll-trigger git hook) when the
// worktree exists, builds the harness resume command, and paints the pane
// identity vars. Returns the window name, or null when the entry has no
// sessionId to resume. Callers own the agentStatus write — attach parks
// interrupted workers at "ready", resurrect always lands at "idle".
export function respawnWorkerWindow(
  projectName: string,
  projectConfig: ProjectConfig,
  entry: WorkerEntry,
  size: { width: number; height: number } | null,
): string | null {
  if (!entry.sessionId) return null;
  // Per-worker base: honors entry.baseBranch pinned at creation, falls
  // back to current-checkout resolution for legacy entries.
  const baseBranch = getWorkerBaseBranch(entry, projectConfig.path);
  if (entry.worktreePath && wtExists(entry.worktreePath)) {
    installPollTriggerHook(entry.worktreePath, resolveGardenRunner(), projectName);
    getHarness(entry.harness).installRuntimeConfig(
      entry.worktreePath, workerProject(projectConfig, entry.provider),
    );
  }
  const workerCwd = entry.worktreePath ?? projectConfig.path;
  const trellisRelativePath = trellisRelativePathForEntry(entry, projectConfig.path);
  // entry.model: default/grow per-worker pin; trellis resolves per
  // iteration, so vines never carry it.
  const resumeOpts: { trellisRelativePath?: string; model?: string; ultracode?: boolean; effort?: string; harness?: string; provider?: string; botanist?: boolean } = {};
  if (trellisRelativePath) resumeOpts.trellisRelativePath = trellisRelativePath;
  if (entry.model) resumeOpts.model = entry.model;
  if (entry.ultracode) resumeOpts.ultracode = true;
  if (entry.effort) resumeOpts.effort = entry.effort;
  if (entry.harness) resumeOpts.harness = entry.harness;
  // `!== undefined`: the empty string is the explicit-first-party marker.
  if (entry.provider !== undefined) resumeOpts.provider = entry.provider;
  if (entry.workflow === "botanist") resumeOpts.botanist = true;
  const resumeCmd = entry.worktreePath && entry.branchName
    ? (resumeOpts.trellisRelativePath || resumeOpts.model || resumeOpts.ultracode || resumeOpts.effort || resumeOpts.harness || resumeOpts.provider !== undefined || resumeOpts.botanist
        ? buildWorktreeResumeCommand(projectName, projectConfig.path, entry.name, entry.branchName, entry.sessionId, baseBranch, resumeOpts)
        : buildWorktreeResumeCommand(projectName, projectConfig.path, entry.name, entry.branchName, entry.sessionId, baseBranch))
    : buildResumeCommand(projectName, projectConfig.path, entry.sessionId);
  const workerWindowName = workerWin(projectName, entry.name);

  // Hold the window open with a no-op placeholder, resize, then respawn
  // with the real resume command. This ensures Claude's TUI first paint
  // happens in a correctly-sized grid; otherwise the new window is created
  // at tmux's default size and the early hard-wrapped lines stay frozen
  // in scrollback at the narrow width.
  // `sleep infinity` is GNU-only; macOS BSD sleep exits 1 and the
  // placeholder pane dies before respawn-pane lands. Use a finite value.
  newDashboardWindow(workerWindowName, "-c", workerCwd, "sh", "-c", "exec sleep 86400");
  if (size) resizeWindow(workerWindowName, size.width, size.height);
  const workerPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindowName}`);
  if (workerPaneId) {
    tmux("respawn-pane", "-k", "-c", workerCwd, "-t", workerPaneId, "sh", "-c", resumeCmd);
    setPaneLabel(workerPaneId, entry.name);
    setPaneVar(workerPaneId, "garden_clock", "1");
    setPaneProjectColor(workerPaneId, projectName);
    if (entry.task) {
      setPaneVar(workerPaneId, "garden_task", entry.task);
      setPaneTitle(workerPaneId, entry.task);
    }
  }
  return workerWindowName;
}

export function buildWorktreeResumeCommand(
  projectName: string,
  projectPath: string,
  workerName: string,
  branchName: string,
  sessionId: string,
  baseBranch?: string,
  opts?: WorktreeCommandOptions,
): string {
  const contextFile = writeWorktreeContextFile(
    projectName, projectPath, branchName, baseBranch,
    { trellisRelativePath: opts?.trellisRelativePath, grow: opts?.grow, botanist: opts?.botanist },
  );
  const gardenRunner = resolveGardenRunner();
  const project = resolveProjectForHooks(projectName, projectPath);
  const identityExports = workerEnvExports(projectName, workerName, branchName, baseBranch);
  const claudeCmd = getHarness(opts?.harness).buildAgentCommand({
    sessionId, resume: true, contextFile, model: opts?.model,
    ultracode: opts?.ultracode, effort: opts?.effort, envPrefix: workerEnvPrefix(workerProject(project, opts?.provider)),
    worktreeGitDir: codexWorktreeGitDir(opts?.harness, projectPath),
  });
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${identityExports} ${claudeCmd}; ${exitHook}; ${pollSignalSnippet(projectName)} exec $SHELL`;
}

// Injects worker identity into claude and the fallback shell so `garden whoami` and `garden logs -w $GARDEN_WORKER` work inside a worker pane.
function workerEnvExports(
  projectName: string,
  workerName: string,
  branchName: string,
  baseBranch: string | undefined,
): string {
  const base = baseBranch ?? "main";
  return (
    `export GARDEN_PROJECT=${shellEscape(projectName)} ` +
    `GARDEN_WORKER=${shellEscape(workerName)} ` +
    `GARDEN_BRANCH=${shellEscape(branchName)} ` +
    `GARDEN_BASE_BRANCH=${shellEscape(base)};` +
    beadsEnvExports(projectName, workerName)
  );
}

// Bead-intake projects only (else empty — the launch command stays
// byte-identical). BEADS_ACTOR names this worker as bd's claim/audit actor —
// `bd update --claim` writes it as assignee, making the bd assignee the
// garden registry key (the board↔garden join contract, DELEGATION.md).
// BEADS_DIR pins bd to the project checkout's canonical store: the worktree
// carries the tracked .beads files but not the gitignored database, so bd
// run bare in the worktree would bootstrap a divergent local DB and the
// worker's `bd close` would never reach board or the intake loop.
export function beadsEnvExports(projectName: string, workerName: string): string {
  const project = tryGetProject(projectName);
  if (project?.beadIntake !== true) return "";
  const beadsDir = path.join(project.path, ".beads");
  return (
    ` export BEADS_ACTOR=${shellEscape(workerName)} ` +
    `BEADS_DIR=${shellEscape(beadsDir)};`
  );
}

function pollSignalSnippet(projectName: string): string {
  const fifoLit = shellEscape(signalFifoPath(projectName));
  return `[ -p ${fifoLit} ] && (echo > ${fifoLit}) 2>/dev/null;`;
}

function writeContextFile(projectName: string, projectPath: string): string {
  const context = buildRulesContext(projectName, projectPath);
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}.context`);
  // Claude reads this on SessionStart and on every --resume. Atomic so a
  // concurrent rewrite (from a parallel command) can't show as a truncated
  // system prompt on the next session start.
  atomicWriteFile(contextFile, context);
  return contextFile;
}

function writeWorktreeContextFile(
  projectName: string,
  projectPath: string,
  branchName: string,
  baseBranch?: string,
  opts?: {
    trellisRelativePath?: string;
    grow?: { iteration: number; maxIterations: number };
    botanist?: boolean;
  },
): string {
  const base = buildRulesContext(projectName, projectPath);
  const checksCommand = tryGetProject(projectName)?.checks;
  const worktreeRules = buildWorktreeRules(
    branchName,
    baseBranch,
    {
      ...(opts?.trellisRelativePath
        ? { trellis: { relativePath: opts.trellisRelativePath } }
        : {}),
      ...(opts?.grow ? { grow: opts.grow } : {}),
      ...(opts?.botanist ? { botanist: true } : {}),
      ...(checksCommand ? { checksCommand } : {}),
    },
  );
  const context = `${base}\n\n${worktreeRules}`;
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}-${branchName}.context`);
  atomicWriteFile(contextFile, context);
  return contextFile;
}

export function writeGrowhouseInitScript(gardenRunner: string): string {
  // gardenRunner is pre-escaped per token by resolveGardenRunner(), so it
  // expands inside the not-found handler body as separate words. Wrapping
  // in shellEscape would single-quote the multi-token string and break it.
  //
  // zsh and bash use different hook names for the not-found handler:
  // zsh = `command_not_found_handler`, bash = `command_not_found_handle`.
  // Define both — only the one matching the operator's shell fires, the
  // other is dead weight. This keeps auto-dispatch working when the user's
  // SHELL is bash. (The file extension stays .zsh because the prompt
  // string above uses zsh-style $'...\\033...' escapes which bash also
  // understands via ANSI-C quoting.)
  //
  // Auto-dispatch via the not-found handler only fires for words the shell
  // can't otherwise resolve. A few garden subcommands share a name with a
  // real binary on PATH — login -> /usr/bin/login, whoami, reset — so the
  // shell runs the binary and the handler never sees them. /usr/bin/login is
  // interactive: it hijacks the growhouse pane with a `login:` prompt that
  // can't be dismissed. Shadow each collision with a function (functions
  // outrank external commands in both bash and zsh) so it routes to garden
  // like any other word at the prompt. `command login` still reaches the
  // real binary if ever needed.
  const script = `# Garden growhouse init — custom prompt with auto-dispatch
PS1=$'\\033[1;32mgarden>\\033[0m '

command_not_found_handler() {
  ${gardenRunner} "$@"
}

command_not_found_handle() {
  ${gardenRunner} "$@"
}

login()  { ${gardenRunner} login "$@"; }
whoami() { ${gardenRunner} whoami "$@"; }
reset()  { ${gardenRunner} reset "$@"; }
`;
  const scriptFile = path.join(SESSIONS_DIR, "growhouse-init.zsh");
  atomicWriteFile(scriptFile, script, { mode: 0o644 });
  return scriptFile;
}

// +1 because pane-border-status top adds one row to the total pane height
export function respawnStatusPane(state: DashboardState): void {
  if (!state.statusPaneId) return;
  const gardenRunner = resolveGardenRunner();
  const statusHeight = Math.max(4, renderQuickStatus(state).split("\n").length) + 1;
  const statusCmd = buildStatusCommand(gardenRunner);
  try { tmux("respawn-pane", "-k", "-t", state.statusPaneId, "sh", "-c", statusCmd); } catch { /* ignore */ }
  try { tmux("resize-pane", "-t", state.statusPaneId, "-y", String(statusHeight)); } catch { /* pane may be gone */ }
  try { tmux("clear-history", "-t", state.statusPaneId); } catch { /* ignore */ }
  disablePaneInput(state.statusPaneId);
  lockPaneMouse(state.statusPaneId);
}

// `garden logs --follow` caches the pre-rebuild bundle in memory; respawn so it picks up new code.
export function respawnLogsPane(state: DashboardState): void {
  let target: string | null = null;
  if (state.gardenPaneType === "logs" && state.gardenShellPaneId) {
    target = state.gardenShellPaneId;
  } else {
    try { target = getFirstPaneId(`${DASHBOARD_SESSION}:_garden-logs`); } catch { /* window doesn't exist */ }
  }
  if (!target) return;
  const scriptFile = writeLogsScript();
  try {
    tmux("respawn-pane", "-k", "-t", target, "sh", "-c", `sh ${shellEscape(scriptFile)}`);
  } catch { /* pane gone */ }
  // Drop the prior render's scrollback so a filter change doesn't leave the
  // pre-filter content visible above the new render. Without this, scrolling
  // up after `⌥/` shows entries the filter is supposed to hide.
  try { tmux("clear-history", "-t", target); } catch { /* pane gone */ }
  // Re-apply in case respawn-pane resets the flag.
  disablePaneInput(target);
}

/**
 * Resize all hidden windows to match the visible pane they'll swap into.
 * Worker/shell windows match the right pane; garden/root/logs match the
 * garden pane. Called on attach so hidden windows are already sized
 * correctly before the first swap — avoiding the SIGWINCH race where
 * resize-window fires right before swap-pane and the TUI hasn't finished
 * redrawing yet — and on every client-resized tick so a hidden worker that
 * keeps working while parked paints its scrollback at the *current* right-slot
 * width. resize-window sets window-size=manual on each window, so without this
 * a terminal resize leaves hidden windows frozen at their old width; the
 * worker's frozen-width scrollback then wraps early (or late) when the operator
 * swaps it in and scrolls up.
 */
export function presizeHiddenWindows(state: DashboardState): void {
  const rightSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
  const gardenSize = state.gardenShellPaneId ? getPaneSize(state.gardenShellPaneId) : null;

  if (!rightSize && !gardenSize) return;

  // Current size of each (single-pane) hidden window, from one tmux fork, so we
  // only resize the windows that actually drifted. An unconditional
  // resize-window fires SIGWINCH and forces a Claude redraw in every hidden
  // worker — wasteful when nothing changed, and this now runs on every
  // client-resized tick during a terminal drag.
  const current = new Map<string, { width: number; height: number }>();
  for (const pane of listSessionPanes()) {
    if (!current.has(pane.windowName)) {
      current.set(pane.windowName, { width: pane.width, height: pane.height });
    }
  }

  const sizeIfDrifted = (name: string, target: { width: number; height: number }) => {
    const cur = current.get(name);
    if (cur && cur.width === target.width && cur.height === target.height) return;
    resizeWindow(name, target.width, target.height);
  };

  for (const name of current.keys()) {
    if (name === "main") continue;

    // Garden pane targets
    if (isGardenWindow(name)) {
      if (gardenSize) sizeIfDrifted(name, gardenSize);
      continue;
    }

    // Skip pollers and review windows — never swapped into a visible slot
    if (name.endsWith("-poller") || name.includes("-review-")) continue;

    // Worker and shell windows target the right pane
    if (rightSize) sizeIfDrifted(name, rightSize);
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
