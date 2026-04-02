// Dashboard header and status bar: renders project tabs (left) and
// priority-based fleet status (right) in the tmux status line.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, loadConfig, getFocusedProjectNames } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxOutput, paneExists, getPanePid, getPaneVar, getPaneTitle, hasClaudeChild, hasChildProcesses, setPaneVar } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { readRegistry, findWorkerByName, updateWorkerTask, type WorkerEntry } from "./registry.js";
import { readAlerts, type Alert } from "./alerts.js";
import { renderQuickStatus } from "../commands/status.js";

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
// Spinner frames and status icons
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const STATUS_ICONS: Record<string, string> = {
  loading:          "\u29D7",     // hourglass
  ready:            "\u25C7",     // open diamond
  working:          SPINNER_FRAMES[0],
  idle:             "\u25C6",     // filled diamond
  pushed:           "\u2191",     // up arrow
  reviewing:        "\u25CE",     // bullseye
  "merge-pending":  "\u25F7",     // circle with right half - queued
  failing:          "\u2716",     // heavy multiplication x
  merged:           "\u2713",     // check mark
  exited:           "\u25CB",     // open circle
};

export { SPINNER_FRAMES };

function spinnerIcon(): string {
  const frame = Math.floor(Date.now() / 2000) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame];
}

// ---------------------------------------------------------------------------
// Per-project aggregate status: pick the "most interesting" worker state
// ---------------------------------------------------------------------------

const STATE_PRIORITY: Record<string, number> = {
  failing: 1,
  reviewing: 2,
  "merge-pending": 3,
  working: 4,
  pushed: 5,
  loading: 6,
  idle: 7,
  merged: 8,
  ready: 9,
  exited: 10,
};

function projectAggregateState(workers: WorkerEntry[]): string | null {
  if (workers.length === 0) return null;
  let best: string | null = null;
  let bestPri = Infinity;
  for (const w of workers) {
    // Use prState if it's a lifecycle state, otherwise fall back to claudeStatus
    const state = (w.prState && w.prState !== "working") ? w.prState : (w.claudeStatus ?? "ready");
    const pri = STATE_PRIORITY[state] ?? 99;
    if (pri < bestPri) {
      bestPri = pri;
      best = state;
    }
  }
  return best;
}

function stateIcon(state: string): string {
  if (state === "working") return spinnerIcon();
  return STATUS_ICONS[state] ?? "";
}

// ---------------------------------------------------------------------------
// Left side: project tabs
// ---------------------------------------------------------------------------

function formatLeft(projectNames: string[], activeProject: string | null, registry: Record<string, WorkerEntry[]>): string {
  if (projectNames.length === 0) return " no projects";
  const tabs: string[] = [];
  for (let i = 0; i < projectNames.length; i++) {
    const name = projectNames[i];
    const workers = registry[name] ?? [];
    const aggState = projectAggregateState(workers);

    let indicator = "";
    if (aggState) {
      const icon = stateIcon(aggState);
      if (aggState === "failing") {
        indicator = `#[fg=red]${icon}#[default]`;
      } else if (aggState === "merged") {
        indicator = `#[fg=green]${icon}#[default]`;
      } else {
        indicator = icon;
      }
    }

    const num = i + 1;
    const suffix = indicator ? indicator : "";
    if (name === activeProject) {
      tabs.push(`#[bold]${num} ${name}${suffix}#[default]`);
    } else {
      tabs.push(`#[fg=default]${num} ${name}${suffix}#[default]`);
    }
  }
  return ` ${tabs.join("  ")} `;
}

// ---------------------------------------------------------------------------
// Right side: priority-based fleet context
// ---------------------------------------------------------------------------

interface FleetCounts {
  failing: number;
  reviewing: number;
  mergePending: number;
  working: number;
  pushed: number;
  merged: number;
  idle: number;
}

function countFleet(registry: Record<string, WorkerEntry[]>): FleetCounts {
  const counts: FleetCounts = { failing: 0, reviewing: 0, mergePending: 0, working: 0, pushed: 0, merged: 0, idle: 0 };
  for (const workers of Object.values(registry)) {
    for (const w of workers) {
      const pr = w.prState;
      if (pr === "failing") counts.failing++;
      else if (pr === "reviewing") counts.reviewing++;
      else if (pr === "merge-pending") counts.mergePending++;
      else if (pr === "pushed") counts.pushed++;
      else if (pr === "merged") counts.merged++;
      else {
        // No lifecycle state — use process status
        const cs = w.claudeStatus;
        if (cs === "working") counts.working++;
        else if (cs === "idle") counts.idle++;
      }
    }
  }
  return counts;
}

function formatFailingAlerts(alerts: Alert[], registry: Record<string, WorkerEntry[]>): string {
  // Show failing workers
  const failingWorkers: string[] = [];
  for (const [project, workers] of Object.entries(registry)) {
    for (const w of workers) {
      if (w.prState === "failing") {
        failingWorkers.push(`${project}/${w.name}`);
      }
    }
  }

  const parts: string[] = [];
  if (failingWorkers.length > 0) {
    const icon = STATUS_ICONS.failing;
    if (failingWorkers.length <= 2) {
      parts.push(`#[fg=red]${icon} ${failingWorkers.join(", ")}#[default]`);
    } else {
      parts.push(`#[fg=red]${icon} ${failingWorkers.length} failing#[default]`);
    }
  }

  // Show most recent alert if it adds information beyond "failing"
  if (alerts.length > 0 && failingWorkers.length === 0) {
    const latest = alerts[alerts.length - 1];
    const prefix = latest.level === "error" ? "#[fg=red]" : "#[fg=yellow]";
    const msg = latest.message.length > 50 ? latest.message.slice(0, 47) + "..." : latest.message;
    parts.push(`${prefix}${msg}#[default]`);
  } else if (alerts.length > 0 && failingWorkers.length > 0) {
    parts.push(`#[fg=yellow]${alerts.length} alert${alerts.length === 1 ? "" : "s"}#[default]`);
  }

  return parts.join("  ");
}

function formatFleetSummary(counts: FleetCounts): string {
  const parts: string[] = [];

  if (counts.failing > 0) {
    parts.push(`#[fg=red]${STATUS_ICONS.failing} ${counts.failing} failing#[default]`);
  }
  if (counts.reviewing > 0) {
    parts.push(`${STATUS_ICONS.reviewing} ${counts.reviewing} reviewing`);
  }
  if (counts.mergePending > 0) {
    parts.push(`${STATUS_ICONS["merge-pending"]} ${counts.mergePending} merging`);
  }
  if (counts.working > 0) {
    parts.push(`${spinnerIcon()} ${counts.working} working`);
  }
  if (counts.pushed > 0) {
    parts.push(`${STATUS_ICONS.pushed} ${counts.pushed} pushed`);
  }
  if (counts.merged > 0) {
    parts.push(`#[fg=green]${STATUS_ICONS.merged} ${counts.merged} merged#[default]`);
  }

  if (parts.length === 0) {
    if (counts.idle > 0) return `${counts.idle} worker${counts.idle === 1 ? "" : "s"} idle`;
    return "no workers";
  }
  return parts.join("  ");
}

function formatRight(registry: Record<string, WorkerEntry[]>, alerts: Alert[]): string {
  // Priority 1: failures and alerts
  if (alerts.length > 0 || Object.values(registry).some(ws => ws.some(w => w.prState === "failing"))) {
    const failAlertStr = formatFailingAlerts(alerts, registry);
    if (failAlertStr) return `${failAlertStr} `;
  }

  // Priority 2: fleet summary
  const counts = countFleet(registry);
  return `${formatFleetSummary(counts)} `;
}

// ---------------------------------------------------------------------------
// Full header update (called by status pane loop with process detection)
// ---------------------------------------------------------------------------

export function printHeader(): void {
  const state = readDashState();
  const config = loadConfig();
  const projectNames = getFocusedProjectNames(config);
  const reg = readRegistry();
  const alerts = readAlerts().alerts;

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

    // Update the cached status in registry so it's reflected in the bar
    if (workerLabel && state.activeProject) {
      const entry = findWorkerByName(state.activeProject, workerLabel);
      if (entry) {
        entry.claudeStatus = paneStatus;
      }
    }
  }

  const left = formatLeft(projectNames, state.activeProject, reg.workers);
  const right = formatRight(reg.workers, alerts);

  // Write to stdout for the status pane loop
  process.stdout.write(left);
  setBarVars(left, right);
}

// ---------------------------------------------------------------------------
// Quick header update (no pgrep, cached registry data only)
// ---------------------------------------------------------------------------

export function updateHeaderVar(opts?: RefreshOptions): void {
  const state = opts?.state ?? readDashState();
  const config = loadConfig();
  const projectNames = getFocusedProjectNames(config);
  const reg = readRegistry();
  const alerts = readAlerts().alerts;

  const left = formatLeft(projectNames, state.activeProject, reg.workers);
  const right = formatRight(reg.workers, alerts);
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
    `trap 'printf "\\033[H\\033[2J\\033[3J"; cat "$sf" 2>/dev/null; echo; sig=1' USR1`,
    `prev=""`,
    `while true; do`,
    `  if [ $sig -eq 0 ]; then`,
    `    ${gardenRunner} dashboard _header >/dev/null 2>&1;`,
    `  fi;`,
    `  sig=0;`,
    `  cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1);`,
    `  if [ "$cur" != "$prev" ]; then`,
    `    printf '\\033[H\\033[2J\\033[3J%s\\n' "$cur";`,
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
    `      printf '\\033[H\\033[2J\\033[3J%s\\n' "$animated";`,
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
