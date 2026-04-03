// Dashboard header and status bar: renders active project context (left)
// and garden build version (right) in the tmux status line.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, loadConfig } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxOutput, paneExists, getPanePid, getPaneVar, getPaneTitle, hasClaudeChild, hasChildProcesses, setPaneVar } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { findWorkerByName, updateWorkerTask } from "./registry.js";
import { resolveBaseBranch } from "./git.js";
import { renderQuickStatus } from "../commands/status.js";
import { GARDEN_VERSION } from "../version.js";

const STATUS_RENDERED_FILE = path.join(SESSIONS_DIR, "status.rendered");
const CLAUDE_EVENT_FILE = path.join(SESSIONS_DIR, "claude-event");

// ---------------------------------------------------------------------------
// Per-worker hook-based active state tracking
// ---------------------------------------------------------------------------
// When Claude runs subagents, they execute in-process (same Node.js event
// loop). pgrep-based child process detection sees no children during API
// calls, so status falls back to "idle". The UserPromptSubmit/Stop hooks
// bracket the entire processing window, including subagent work. We write a
// marker file on "prompt" and remove it on "stop" so status detection can
// distinguish "idle at prompt" from "working with no child processes".
// ---------------------------------------------------------------------------

function claudeActiveMarkerPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `claude-active-${project}-${worker}`);
}

function workerFromCwd(): { project: string; worker: string } | null {
  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  const prefix = path.join(home, ".garden", "worktrees") + path.sep;
  if (!cwd.startsWith(prefix)) return null;
  const parts = cwd.slice(prefix.length).split(path.sep);
  if (parts.length < 2) return null;
  return { project: parts[0], worker: parts[1] };
}

// Marker older than this is considered stale (Claude likely crashed without
// firing the Stop hook). 5 minutes is generous — even long tool runs rarely
// go silent for that long without any subprocess activity.
const MARKER_STALE_MS = 5 * 60 * 1000;

export function isClaudeActiveByHook(project: string, worker: string): boolean {
  try {
    const p = claudeActiveMarkerPath(project, worker);
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > MARKER_STALE_MS) {
      fs.unlinkSync(p);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function removeClaudeActiveMarker(project: string, worker: string): void {
  try { fs.unlinkSync(claudeActiveMarkerPath(project, worker)); } catch { /* ignore */ }
}

interface RefreshOptions {
  state?: DashboardState;
  windowNames?: string[];
}

export function setupStatusBar(_gardenRunner: string): void {
  const target = DASHBOARD_SESSION;
  const mainWindow = `${DASHBOARD_SESSION}:main`;
  const opts: Array<[string[], string]> = [
    // Session options
    [["-t", target, "mouse", "on"], "mouse"],
    [["-t", target, "status-left-length", "80"], "status-left-length"],
    [["-t", target, "status-left", "#{@garden_left}"], "status-left"],
    [["-t", target, "status-right-length", "120"], "status-right-length"],
    [["-t", target, "status-right", "#{@garden_right}"], "status-right"],
    [["-t", target, "status-interval", "2"], "status-interval"],
    // Window options — suppress window names for all windows in this session
    [["-t", mainWindow, "window-status-current-format", ""], "window-status-current-format"],
    [["-t", mainWindow, "window-status-format", ""], "window-status-format"],
    [["-t", mainWindow, "pane-border-status", "top"], "pane-border-status"],
    [["-t", mainWindow, "pane-border-format",
      "#{?@garden_name, #{@garden_name}#{?@garden_task, - #{@garden_task},} ,}"], "pane-border-format"],
  ];
  for (const [args] of opts) {
    try { tmux("set-option", ...args); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Spinner frames (used by status pane animation in buildStatusCommand)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

// ---------------------------------------------------------------------------
// Left side: active project and its base branch
// ---------------------------------------------------------------------------

function formatLeft(activeProject: string | null, config: ReturnType<typeof loadConfig>): string {
  if (!activeProject) return " no projects";
  const projectConfig = config.projects[activeProject];
  const repoPath = projectConfig?.path ?? "";
  const baseBranch = repoPath ? resolveBaseBranch(repoPath, projectConfig) : "main";
  return ` #[bold]${activeProject}#[default]  ${baseBranch} `;
}

// ---------------------------------------------------------------------------
// Right side: garden build version
// ---------------------------------------------------------------------------

function formatRight(): string {
  return `garden ${GARDEN_VERSION} `;
}

// ---------------------------------------------------------------------------
// Full header update (called by status pane loop with process detection)
// ---------------------------------------------------------------------------

export function printHeader(): void {
  const state = readDashState();
  const config = loadConfig();

  // If active pane is a worker, do process detection to update registry
  if (state.activeProject && state.activePaneId && paneExists(state.activePaneId) && state.activePaneType === "worker") {
    const workerNameMatch = (state.activeWindowName ?? "").match(/-worker-(.+)$/);
    const workerLabel = workerNameMatch ? workerNameMatch[1] : null;

    const pid = getPanePid(state.activePaneId);
    const claudeRunning = pid && hasClaudeChild(pid);

    let title = getPaneVar(state.activePaneId, "garden_task");
    if (!title && workerLabel && state.activeProject) {
      const entry = findWorkerByName(state.activeProject, workerLabel);
      if (entry?.task) title = entry.task;
    }
    if (claudeRunning) {
      const liveTitle = getPaneTitle(state.activePaneId) ?? null;
      if (liveTitle) title = liveTitle;
    }
    if (title) {
      setPaneVar(state.activePaneId, "garden_task", title);
      if (workerLabel && state.activeProject) {
        updateWorkerTask(state.activeProject, workerLabel, title);
      }
    }

    let paneStatus = "";
    if (claudeRunning) {
      paneStatus = title ? "working" : "ready";
    } else if (title) {
      paneStatus = "exited";
    } else if (pid && hasChildProcesses(pid)) {
      paneStatus = "loading";
    } else {
      paneStatus = "ready";
      setPaneVar(state.activePaneId, "garden_task", "");
    }

    if (workerLabel && state.activeProject) {
      const entry = findWorkerByName(state.activeProject, workerLabel);
      if (entry) {
        entry.claudeStatus = paneStatus;
      }
    }
  }

  const left = formatLeft(state.activeProject, config);
  const right = formatRight();
  setBarVars(left, right);
}

// ---------------------------------------------------------------------------
// Quick header update (no pgrep, cached registry data only)
// ---------------------------------------------------------------------------

export function updateHeaderVar(opts?: RefreshOptions): void {
  const state = opts?.state ?? readDashState();
  const config = loadConfig();

  const left = formatLeft(state.activeProject, config);
  const right = formatRight();
  setBarVars(left, right);
}

// ---------------------------------------------------------------------------
// tmux variable helpers
// ---------------------------------------------------------------------------

function setBarVars(left: string, right: string): void {
  try {
    const t = DASHBOARD_SESSION;
    // Ensure format strings point to the correct variables. Idempotent and
    // cheap — self-heals after CLI rebuilds without requiring dashboard restart.
    tmux("set-option", "-t", t, "status-left", "#{@garden_left}");
    tmux("set-option", "-t", t, "status-right", "#{@garden_right}");
    tmux("set-option", "-t", t, "@garden_left", left);
    tmux("set-option", "-t", t, "@garden_right", right);
    // Suppress window names in the status bar center area. Hidden worker
    // windows would otherwise leak their names into the window list.
    suppressWindowNames();
    tmux("refresh-client", "-S");
  } catch { /* no client attached or session gone */ }
}

function suppressWindowNames(): void {
  try {
    const windows = tmuxOutput("list-windows", "-t", DASHBOARD_SESSION, "-F", "#{window_name}");
    for (const win of windows.split("\n").filter(Boolean)) {
      const target = `${DASHBOARD_SESSION}:${win}`;
      try {
        tmux("set-option", "-t", target, "window-status-format", "");
        tmux("set-option", "-t", target, "window-status-current-format", "");
      } catch { /* window may have been killed */ }
    }
  } catch { /* session gone */ }
}


// ---------------------------------------------------------------------------
// Claude hook handler
// ---------------------------------------------------------------------------

export function handleClaudeHook(event: string): void {
  // Track per-worker active state via marker files so status detection can
  // distinguish "idle at prompt" from "working with in-process subagents".
  const workerInfo = workerFromCwd();
  if (workerInfo) {
    const markerPath = claudeActiveMarkerPath(workerInfo.project, workerInfo.worker);
    if (event === "prompt") {
      try { fs.writeFileSync(markerPath, "1"); } catch { /* best effort */ }
    } else {
      try { fs.unlinkSync(markerPath); } catch { /* best effort */ }
    }
  }

  try {
    fs.writeFileSync(CLAUDE_EVENT_FILE, event);
  } catch { /* best effort */ }
  refreshDashboard();
}

// ---------------------------------------------------------------------------
// Status pane command builder
// ---------------------------------------------------------------------------

export function buildStatusCommand(gardenRunner: string): string {
  const sf = STATUS_RENDERED_FILE;
  const ef = CLAUDE_EVENT_FILE;
  const brailleClass = `[${SPINNER_FRAMES.join("")}]`;
  const caseBranches = SPINNER_FRAMES.map((f, i) => `${i}) sf_char='${f}';;`).join(" ");
  return [
    `printf '\\033[H\\033[2J\\033[3J'`,
    `sf='${sf}'`,
    `ef='${ef}'`,
    `sig=0`,
    `trap '_t=$(cat "$sf" 2>/dev/null); printf "\\033[H%s\\n\\033[J" "$_t"; prev="$_t"; sig=1' USR1`,
    `prev=""`,
    `while true; do`,
    `  if [ $sig -eq 0 ]; then`,
    `    ${gardenRunner} dashboard _header >/dev/null 2>&1;`,
    `  fi;`,
    `  sig=0;`,
    `  cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1 | awk '{printf "%s\\033[K\\n", $0}');`,
    `  if [ "$cur" != "$prev" ]; then`,
    `    printf '\\033[H%s\\n\\033[J' "$cur";`,
    `    prev="$cur";`,
    `  fi;`,
    // Read and consume event marker to decide whether to animate
    `  ev=""`,
    `  [ -f "$ef" ] && ev=$(cat "$ef" 2>/dev/null) && rm -f "$ef"`,
    // When "prompt" hook fires but pgrep didn't detect tool children (no
    // braille spinner in output), inject a spinner on the active worker line
    // (marked with ●) so the animation sed has something to replace.
    `  if [ "$ev" = "prompt" ] && ! printf '%s' "$cur" | grep -q '${brailleClass}'; then`,
    `    cur=$(printf '%s' "$cur" | perl -CSD -pe 's/(\\x{25CF} )\\S/$1\\x{280B}/')`,
    `  fi`,
    // Animate spinner when any worker has a braille spinner character.
    `  if printf '%s' "$cur" | grep -q '${brailleClass}'; then`,
    `    sc=0;`,
    `    while [ $sc -lt 500 ]; do`,
    `      sleep 0.08 & wait $! 2>/dev/null;`,
    `      if [ $sig -eq 1 ]; then break; fi;`,
    `      sc=$((sc + 1));`,
    `      si=$((sc % ${SPINNER_FRAMES.length}));`,
    `      case $si in ${caseBranches} esac;`,
    `      animated=$(printf '%s' "$cur" | sed "s/${brailleClass}/$sf_char/g");`,
    `      printf '\\033[H%s\\n\\033[J' "$animated";`,
    `    done;`,
    `  else`,
    // Block until signaled — no polling.
    `    sleep 120 & wait $! 2>/dev/null;`,
    `  fi;`,
    `done`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Refresh helpers
// ---------------------------------------------------------------------------

export function refreshStatusPane(opts?: RefreshOptions): void {
  const state = opts?.state ?? readDashState();
  if (!state.statusPaneId) return;
  try {
    const pid = getPanePid(state.statusPaneId);
    if (pid) process.kill(parseInt(pid, 10), "SIGUSR1");
  } catch { /* pane gone or process exited */ }
}

export function refreshDashboard(opts?: RefreshOptions): void {
  updateHeaderVar(opts);
  writeQuickStatus(opts);
  refreshStatusPane(opts);
}

function writeQuickStatus(opts?: RefreshOptions): void {
  try {
    const state = opts?.state ?? readDashState();
    const rendered = renderQuickStatus(state, opts?.windowNames);
    const tmpFile = STATUS_RENDERED_FILE + ".tmp";
    fs.writeFileSync(tmpFile, rendered);
    fs.renameSync(tmpFile, STATUS_RENDERED_FILE);
  } catch { /* best effort */ }
}
