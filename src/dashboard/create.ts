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
import { type DashboardState, readDashState, writeDashState, STATE_FILE } from "./state.js";
import { restoreFromHidden } from "./layout.js";
import { setupKeybindings } from "./hotkeys.js";
import { setupStatusBar, buildStatusCommand, buildUsageCommand, updateHeaderVar, installInputGuard } from "./header.js";
import { renderQuickStatus } from "../commands/status.js";
import { formatLogsPaneLabel } from "../commands/logs.js";
import {
  tmux, tmuxOutput, tmuxSplit, setPaneTitle, setPaneLabel, setPaneVar,
  getFirstPaneId, shellEscape, tmuxDoubleQuote,
  getPaneSize, resizeWindow, listAllWindowNames, disablePaneInput,
} from "./tmux.js";
import { readRegistry, updateWorkerFields } from "./registry.js";
import { log, truncateLog } from "./log.js";
import { validateAndHeal } from "./validate.js";
import { startProjectPoller, signalFifoPath, restartLongLivedPollers } from "./poller.js";
import { startUsagePoller } from "./usage-poller.js";
import { installPollTriggerHook, worktreeExists as wtExists, getWorkerBaseBranch, getRemoteHost } from "./git.js";
import { dispatchDelayedContinue } from "./continue.js";
import { resolveGardenRunner } from "./runner.js";
import { buildSandboxConfig, type SandboxConfig } from "./sandbox.js";
import {
  DONE_SKILL_CONTENT, DONE_SKILL_DIRNAME, DONE_SKILL_FILENAME,
  HANDOFF_SKILL_CONTENT, HANDOFF_SKILL_DIRNAME, HANDOFF_SKILL_FILENAME,
  TRELLIS_AUTHOR_SKILL_CONTENT, TRELLIS_AUTHOR_SKILL_DIRNAME, TRELLIS_AUTHOR_SKILL_FILENAME,
  GROW_SKILL_CONTENT, GROW_SKILL_DIRNAME, GROW_SKILL_FILENAME,
  installClaudeSkills,
} from "./skills.js";
import { claudeEnvPrefix } from "./claude-env.js";
import { gardenWindowName, shellWindowName as shellWin, workerWindowName as workerWin, isGardenWindow } from "./window-names.js";

const DASHBOARD_COLS = 250;
const DASHBOARD_ROWS = 60;

// Usage pane height: 3 meter lines + 1 leading blank + 1 pane-border-status top row.
export const USAGE_PANE_HEIGHT = 5;

function buildSettingsJson(gardenRunner: string, sandbox: SandboxConfig): string {
  // The hook commands are written into JSON and ultimately executed by Claude
  // Code as shell commands. The runner is already pre-escaped per token by
  // resolveGardenRunner(), so it interpolates safely without re-wrapping.
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
      PermissionRequest: [{
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} pretooluse`, timeout: 5 }],
      }],
      PostToolUse: [{
        // Catch-all: auto-mode escalates any tool the classifier flags (Write,
        // Edit, Read, Bash, WebFetch, ...), not just Bash — so we need to see
        // every tool completion to clear "asking" after the operator approves.
        matcher: "",
        hooks: [{ type: "command", command: `${hookCmd} posttooluse`, timeout: 5 }],
      }],
    },
    sandbox,
    permissions: {
      defaultMode: "auto",
      // Every subcommand of a compound bash call must match a rule, so tmux chains like `tmux ... | head` still prompt without tail-utility allowances.
      allow: [
        "Bash(tmux:*)",
        "Bash(echo:*)",
        "Bash(head:*)",
        "Bash(tail:*)",
        "Bash(cat:*)",
        "Bash(grep:*)",
        "Bash(wc:*)",
      ],
    },
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

// Write to settings.json, not settings.local.json — Claude Code auto-edits the latter (permission approvals) and clobbers our hooks.
// Atomic write: Claude reads settings.json on SessionStart and on every --resume, so a partial file would break hook config silently.
// Mode 0o444 (read-only): defense-in-depth against an agent self-disabling
// its own sandbox. The worktree itself is writable by the worker (that's
// the point of the sandbox's allowWrite root), so a determined process can
// chmod the file before editing — but auto-mode's classifier escalates a
// chmod, and `installClaudeHooks` is invoked on every refresh/bounce, so
// any tampering is rewritten on the next cycle. This makes the path of
// least resistance "ask the operator" rather than "edit the file."
export function installClaudeHooks(targetDir: string, project: ProjectConfig): void {
  const sandbox = sandboxForTarget(targetDir, project);
  const json = buildSettingsJson(resolveGardenRunner(), sandbox);
  const settingsPath = path.join(targetDir, ".claude", "settings.json");
  // atomicWriteFile preserves the mode through tmp→rename. If the file
  // already exists with a different mode (operator chmod, agent
  // tampering), the rename replaces it with the read-only version.
  atomicWriteFile(settingsPath, json, { mode: 0o444 });
  installClaudeSkills(targetDir);
  ensureWorktreeExcludes(targetDir);
}

// Heal `.git/info/exclude` for existing worktrees. The bootstrap script
// writes these patterns at worker-spawn time (see further down this file),
// but workers spawned before a new pattern was added need a refresh path.
// installClaudeHooks runs on every dashboard refresh + bounce + post-merge
// auto-continue, so worktrees from earlier garden versions heal on their
// next cycle instead of carrying stale excludes forever.
//
// The exclude file lives at the git common dir (shared across worktrees);
// a missing entry is added once and persists.
function ensureWorktreeExcludes(targetDir: string): void {
  // The patterns must stay in sync with the bootstrap script's `for pattern`
  // loop further down in this file. .claude/ + .garden-hooks/ shipped with
  // the original worker; .garden/ was added when the grow workflow's goal +
  // log files needed to be hidden from git status; .garden-done is the
  // auto-continue suppression sentinel (so an accidental `git add -A` won't
  // start tracking it the way it did on wolf's main).
  const patterns = [".claude/", ".garden-hooks/", ".garden/", ".garden-done"];
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["-C", targetDir, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return; // Worktree may not exist yet on first hook installation.
  }
  // commonDir may be relative when targetDir is a worktree — resolve it
  // against targetDir so the join below points at the right info/exclude.
  const resolvedCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(targetDir, commonDir);
  const excludeFile = path.join(resolvedCommonDir, "info", "exclude");
  let current: string;
  try {
    current = fs.readFileSync(excludeFile, "utf-8");
  } catch {
    return; // No exclude file yet (rare; bootstrap will create one).
  }
  const lines = new Set(current.split("\n").map(l => l.trim()));
  const missing = patterns.filter(p => !lines.has(p));
  if (missing.length === 0) return;
  const tail = (current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n";
  try {
    fs.appendFileSync(excludeFile, tail);
  } catch {
    /* best effort — exclude is informational, not load-bearing */
  }
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
    }

    // Re-pin the usage pane on terminal resize. Minimal handler (resize-pane only)
    // so it doesn't disturb copy-mode in worker/logs panes the way the old refreshDashboard-based hook did (a10642c).
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
          installClaudeHooks(entry.worktreePath, proj);
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
  // claudeStatus="exited" to the registry. This is the only mechanism in
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

  // Re-pin usage pane on terminal resize (see reattach path for rationale).
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
    activePaneId: rightPaneId,
    activePaneType: firstProject ? "shell" : null,
    activeWindowName: firstProject ? shellWin(firstProject) : null,
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
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
      // Per-worker base: honors entry.baseBranch pinned at creation, falls
      // back to current-checkout resolution for legacy entries.
      const baseBranch = getWorkerBaseBranch(entry, projectConfig.path);
      if (entry.worktreePath && wtExists(entry.worktreePath)) {
        installPollTriggerHook(entry.worktreePath, gardenRunner, projectName);
        installClaudeHooks(entry.worktreePath, projectConfig);
      }
      // Capture mid-turn interruption before we overwrite claudeStatus below.
      // pane-died sets interruptedWhileWorking when claudeStatus was "working"
      // at exit; if pane-died never fired (tmux server crash), claudeStatus
      // itself will still be "working".
      const wasInterrupted = entry.interruptedWhileWorking === true
        || entry.claudeStatus === "working";
      // Claude Code does not fire SessionStart on --resume, so the SessionStart
      // hook will not write claudeStatus for resumed workers. Write "idle"
      // directly: a resumed worker is at the prompt by definition, and the
      // first user prompt will flip it to "working" via UserPromptSubmit.
      // prState is preserved as-is from the previous session.
      updateWorkerFields(projectName, entry.name, { claudeStatus: "idle" });
      const workerCwd = entry.worktreePath ?? projectConfig.path;
      const trellisRelativePath = trellisRelativePathForEntry(entry, projectConfig.path);
      const resumeCmd = entry.worktreePath && entry.branchName
        ? (trellisRelativePath
            ? buildWorktreeResumeCommand(projectName, projectConfig.path, entry.name, entry.branchName, entry.sessionId, baseBranch, { trellisRelativePath })
            : buildWorktreeResumeCommand(projectName, projectConfig.path, entry.name, entry.branchName, entry.sessionId, baseBranch))
        : buildResumeCommand(projectName, projectConfig.path, entry.sessionId);
      const workerWindowName = workerWin(projectName, entry.name);

      // Hold the window open with a no-op placeholder, resize, then respawn
      // with the real resume command. This ensures Claude's TUI first paint
      // happens in a correctly-sized grid; otherwise the new window is created
      // at tmux's default size and the early hard-wrapped lines stay frozen
      // in scrollback at the narrow width.
      tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", workerCwd,
        "sh", "-c", "exec sleep infinity");
      if (rightSize) resizeWindow(workerWindowName, rightSize.width, rightSize.height);
      const workerPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindowName}`);
      if (workerPaneId) {
        tmux("respawn-pane", "-k", "-c", workerCwd, "-t", workerPaneId, "sh", "-c", resumeCmd);
        setPaneLabel(workerPaneId, entry.name);
        if (entry.task) {
          setPaneVar(workerPaneId, "garden_task", entry.task);
          setPaneTitle(workerPaneId, entry.task);
        }
      }

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
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName);
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) {
    setPaneLabel(paneId, "growhouse");
    setPaneTitle(paneId, "growhouse");
    tmux("send-keys", "-t", paneId, `source ${shellEscape(growhouseInit)} && clear`, "Enter");
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
  const gardenRunner = resolveGardenRunner();
  const contextFile = writeContextFile(projectName, projectPath);
  const envPrefix = claudeEnvPrefix(project);
  const claudeCmd = `${envPrefix}claude --rc --session-id ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${claudeCmd}; ${exitHook}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
}

export function buildResumeCommand(projectName: string, projectPath: string, sessionId: string): string {
  const project = resolveProjectForHooks(projectName, projectPath);
  installClaudeHooks(projectPath, project);
  const gardenRunner = resolveGardenRunner();
  const contextFile = writeContextFile(projectName, projectPath);
  const envPrefix = claudeEnvPrefix(project);
  const claudeCmd = `${envPrefix}claude --rc --resume ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
  const exitHook = `${gardenRunner} dashboard _claude-hook stop 2>/dev/null || true`;
  return `${claudeCmd}; ${exitHook}; clear; echo "Worker exited. ⌥x to close, ⌥n for new, ⌥s for shell."; exec $SHELL`;
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
   *  model. When unset (default workers), claude uses the account default
   *  and no `--model` flag is passed. Trellis vines pass "sonnet" by
   *  default; the per-worker `--model` override (persisted to
   *  `entry.workerModel`) and the Sonnet exhaustion fallback (resolved
   *  via `resolveVineModel`) override per iteration. */
  model?: "opus" | "sonnet";
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
    { trellisRelativePath: opts?.trellisRelativePath, grow: opts?.grow },
  );
  const project = resolveProjectForHooks(projectName, projectPath);
  const envPrefix = claudeEnvPrefix(project);
  const modelFlag = opts?.model ? ` --model ${shellEscape(opts.model)}` : "";
  const claudeCmd = `${envPrefix}claude --rc${modelFlag} --session-id ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
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
    { trellisRelativePath: opts?.trellisRelativePath, grow: opts?.grow },
  );

  const fifoLit = shellEscape(signalFifoPath(projectName));
  const pollSignal = `[ -p ${fifoLit} ] && (echo > ${fifoLit}) 2>/dev/null;`;

  const projectPathLit = shellEscape(projectPath);
  const wtPathLit = shellEscape(wtPath);
  const contextFileLit = shellEscape(contextFile);
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
  const sandbox = sandboxForTarget(wtPath, project);
  const settingsJson = buildSettingsJson(gardenRunner, sandbox);
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
  const envPrefix = claudeEnvPrefix(project);
  const modelFlag = opts?.model ? ` --model ${shellEscape(opts.model)}` : "";

  const base = baseBranch ?? "main";
  const baseLit = shellEscape(base);
  const projectNameLit = shellEscape(projectName);
  const branchLit = shellEscape(branchName);
  const workerLit = shellEscape(workerName);

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

# Install poll trigger hook
mkdir -p ${hooksDirLit}
printf '${hookContent}\\n' | atomic_write ${hookPathLit}
chmod 755 ${hookPathLit}
git -C ${wtPathLit} config --local core.hooksPath ${hooksDirLit}

# Install Claude Code hooks — settings.json (not .local.json, which Claude Code auto-edits and would clobber).
# chmod 444: defense-in-depth so an agent can't trivially edit its own
# sandbox without first chmod'ing — installClaudeHooks rewrites this on
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

# Ensure garden-managed dirs are excluded from git status.
# Writing to the common info/exclude covers all worktrees and never gets committed.
# .garden/ covers per-worker artifacts (grow-goal.md, grow-log.md,
# trellis-lessons.md) — none of these belong in version control. .garden-done
# is the auto-continue suppression sentinel; the done skill description
# advertises this exclusion as the reason workers should not \`git add\` it.
EXCLUDE_FILE="$(git -C ${wtPathLit} rev-parse --git-common-dir)/info/exclude"
for pattern in .claude/ .garden-hooks/ .garden/ .garden-done; do
  grep -qxF "$pattern" "$EXCLUDE_FILE" 2>/dev/null || printf '%s\\n' "$pattern" >> "$EXCLUDE_FILE"
done

# Switch to the worktree directory
cd ${wtPathLit}
printf '  Ready.\\n\\n'

# Launch claude
${envPrefix}claude --rc${modelFlag} --session-id ${sessionId} --append-system-prompt-file ${contextFileLit}
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
    { trellisRelativePath: opts?.trellisRelativePath, grow: opts?.grow },
  );
  const gardenRunner = resolveGardenRunner();
  const project = resolveProjectForHooks(projectName, projectPath);
  const envPrefix = claudeEnvPrefix(project);
  const identityExports = workerEnvExports(projectName, workerName, branchName, baseBranch);
  const modelFlag = opts?.model ? ` --model ${shellEscape(opts.model)}` : "";
  const claudeCmd = `${envPrefix}claude --rc${modelFlag} --resume ${sessionId} --append-system-prompt-file ${shellEscape(contextFile)}`;
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
    `GARDEN_BASE_BRANCH=${shellEscape(base)};`
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
      ...(checksCommand ? { checksCommand } : {}),
    },
  );
  const context = `${base}\n\n${worktreeRules}`;
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}-${branchName}.context`);
  atomicWriteFile(contextFile, context);
  return contextFile;
}

function writeGrowhouseInitScript(gardenRunner: string): string {
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
  const script = `# Garden growhouse init — custom prompt with auto-dispatch
PS1=$'\\033[1;32mgarden>\\033[0m '

command_not_found_handler() {
  ${gardenRunner} "$@"
}

command_not_found_handle() {
  ${gardenRunner} "$@"
}
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
