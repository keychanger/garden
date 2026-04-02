// Dashboard header and status bar: renders project info and hotkey hints
// in the tmux status line.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, paneExists, getPanePid, getPaneVar, getPaneTitle, hasClaudeChild, hasChildProcesses, listHiddenWorkerWindows, setPaneVar } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { findWorkerByName, updateWorkerTask } from "./registry.js";
import { alertCount } from "./alerts.js";
import { renderQuickStatus } from "../commands/status.js";

const STATUS_RENDERED_FILE = path.join(SESSIONS_DIR, "status.rendered");

interface RefreshOptions {
  state?: DashboardState;
  windowNames?: string[];
}

export function setupStatusBar(gardenRunner: string): void {
  const target = DASHBOARD_SESSION;
  const mainWindow = `${DASHBOARD_SESSION}:main`;
  const opts: Array<[string[], string]> = [
    // Session options
    [["-t", target, "mouse", "on"], "mouse"],
    [["-t", target, "status-right-length", "120"], "status-right-length"],
    [["-t", target, "status-right", "#{@garden_header}"], "status-right"],
    [["-t", target, "status-interval", "2"], "status-interval"],
    [["-t", target, "status-left", ""], "status-left"],
    [["-t", target, "status-left-length", "0"], "status-left-length"],
    // Window options — target main window directly to override user globals
    [["-t", mainWindow, "window-status-current-format", "garden"], "window-status-current-format"],
    [["-t", mainWindow, "window-status-format", ""], "window-status-format"],
    [["-t", mainWindow, "pane-border-status", "top"], "pane-border-status"],
    [["-t", mainWindow, "pane-border-format",
      "#{?@garden_name, #{@garden_name}#{?@garden_task, - #{@garden_task},} ,}"], "pane-border-format"],
  ];
  for (const [args] of opts) {
    try { tmux("set-option", ...args); } catch { /* ignore */ }
  }
}

/**
 * Full header update: queries process status, updates pane vars and registry,
 * then sets the @garden_header tmux variable. Called by the status pane's
 * background loop every few seconds for live process detection.
 */
export function printHeader(): void {
  const state = readDashState();

  if (!state.activeProject) {
    const header = "no project selected  [⌥1-⌥9 select]";
    process.stdout.write(header);
    setHeaderVar(header);
    return;
  }

  const projectName = state.activeProject;

  const hiddenWorkers = listHiddenWorkerWindows(projectName);
  let totalWorkers = hiddenWorkers.length;
  let currentWorkerIdx = 0;
  const isOnWorker = state.activePaneType === "worker";
  if (isOnWorker) {
    totalWorkers++;
    const currentName = state.activeWindowName ?? "";
    const allWorkers = [...new Set([currentName, ...hiddenWorkers])].sort();
    currentWorkerIdx = allWorkers.indexOf(currentName) + 1;
  }

  const workerNameMatch = (state.activeWindowName ?? "").match(/-worker-(.+)$/);
  const workerLabel = workerNameMatch ? workerNameMatch[1] : null;

  let paneStatus = "";
  if (state.activePaneId && paneExists(state.activePaneId)) {
    if (state.activePaneType === "shell") {
      paneStatus = "shell";
    } else {
      const pid = getPanePid(state.activePaneId);
      const claudeRunning = pid && hasClaudeChild(pid);

      let title = getPaneVar(state.activePaneId, "garden_task");
      if (!title && workerLabel && state.activeProject) {
        const entry = findWorkerByName(state.activeProject, workerLabel);
        if (entry?.task) {
          title = entry.task;
        }
      }
      if (!title && claudeRunning) {
        title = getPaneTitle(state.activePaneId) ?? null;
      }
      if (title) {
        setPaneVar(state.activePaneId, "garden_task", title);
        if (workerLabel && state.activeProject) {
          updateWorkerTask(state.activeProject, workerLabel, title);
        }
      }

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
    }
  }

  let prState = "";
  let mergeCount = 0;
  if (workerLabel && state.activeProject) {
    const entry = findWorkerByName(state.activeProject, workerLabel);
    if (entry?.prState && entry.prState !== "working") {
      prState = entry.prState;
    }
    mergeCount = entry?.mergeCount ?? 0;
  }

  const alerts = alertCount();
  const header = formatHeader(projectName, isOnWorker, workerLabel, paneStatus, currentWorkerIdx, totalWorkers, prState, mergeCount, alerts);
  process.stdout.write(header);
  setHeaderVar(header);
}

/**
 * Quick header update: builds header from state and tmux window list only
 * (no process detection, no pgrep). Called synchronously after mutations
 * for instant visual feedback. The background loop fills in live status.
 */
export function updateHeaderVar(opts?: RefreshOptions): void {
  const state = opts?.state ?? readDashState();

  if (!state.activeProject) {
    setHeaderVar("no project selected  [⌥1-⌥9 select]");
    return;
  }

  const projectName = state.activeProject;

  const hiddenWorkers = listHiddenWorkerWindows(projectName, opts?.windowNames);
  let totalWorkers = hiddenWorkers.length;
  let currentWorkerIdx = 0;
  const isOnWorker = state.activePaneType === "worker";
  if (isOnWorker) {
    totalWorkers++;
    const currentName = state.activeWindowName ?? "";
    const allWorkers = [...new Set([currentName, ...hiddenWorkers])].sort();
    currentWorkerIdx = allWorkers.indexOf(currentName) + 1;
  }

  const workerNameMatch = (state.activeWindowName ?? "").match(/-worker-(.+)$/);
  const workerLabel = workerNameMatch ? workerNameMatch[1] : null;

  const paneStatus = state.activePaneType === "shell" ? "shell" : "";

  let prState = "";
  let mergeCount = 0;
  if (workerLabel && state.activeProject) {
    const entry = findWorkerByName(state.activeProject, workerLabel);
    if (entry?.prState && entry.prState !== "working") {
      prState = entry.prState;
    }
    mergeCount = entry?.mergeCount ?? 0;
  }

  const alerts = alertCount();
  const header = formatHeader(projectName, isOnWorker, workerLabel, paneStatus, currentWorkerIdx, totalWorkers, prState, mergeCount, alerts);
  setHeaderVar(header);
}

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const HEADER_STATUS_ICONS: Record<string, string> = {
  loading:          "\u29D7",     // hourglass
  ready:            "\u25C7",     // open diamond
  working:          SPINNER_FRAMES[0],
  idle:             "\u25C6",     // filled diamond
  pushed:           "\u2191",     // up arrow
  reviewing:        "\u25CE",     // bullseye
  "merge-pending":  "\u25F7",    // circle with right half - queued
  failing:          "\u2716",     // heavy multiplication x
  merged:           "\u2713",     // check mark
  exited:           "\u25CB",     // open circle
};

function headerIcon(paneStatus: string, prState?: string): string {
  const effectiveState = prState || paneStatus;
  if (effectiveState === "working") {
    const frame = Math.floor(Date.now() / 2000) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[frame];
  }
  return HEADER_STATUS_ICONS[effectiveState] ?? "";
}

function formatHeader(
  projectName: string,
  isOnWorker: boolean,
  workerLabel: string | null,
  paneStatus: string,
  currentWorkerIdx: number,
  totalWorkers: number,
  prState?: string,
  mergeCount?: number,
  alerts?: number,
): string {
  const parts: string[] = [projectName];

  if (isOnWorker && totalWorkers > 0) {
    const label = workerLabel ?? "worker";
    const effectiveState = prState || paneStatus;
    const displayState = effectiveState === "merge-pending" ? "merge pending" : effectiveState;
    const icon = headerIcon(paneStatus, prState);
    const statusParts = [displayState].filter(Boolean);
    if (mergeCount && mergeCount > 0) {
      statusParts.push(`${mergeCount} merged`);
    }
    const status = statusParts.length > 0 ? ` (${statusParts.join(", ")})` : "";
    parts.push(`${icon} ${label}${status} [${currentWorkerIdx}/${totalWorkers}]`);
  } else if (paneStatus && paneStatus !== "shell") {
    const icon = headerIcon(paneStatus);
    parts.push(`${icon} ${paneStatus}`);
    if (totalWorkers > 0) {
      parts.push(`${totalWorkers} worker${totalWorkers === 1 ? "" : "s"} parked`);
    }
  } else if (paneStatus === "shell") {
    if (totalWorkers > 0) {
      parts.push(`${totalWorkers} worker${totalWorkers === 1 ? "" : "s"} parked`);
    }
  }

  const info = parts.join(" \u00B7 ");
  const alertTag = alerts && alerts > 0
    ? `  [${alerts} alert${alerts === 1 ? "" : "s"}]`
    : "";
  const hints = "\u2325n new | \u2325w worker | \u2325s shell | \u2325l logs | \u2325] next";
  return `${info}${alertTag}  ${hints}`;
}

function setHeaderVar(header: string): void {
  try {
    tmux("set-option", "-t", DASHBOARD_SESSION, "@garden_header", header);
    tmux("refresh-client", "-S");
  } catch { /* no client attached or session gone */ }
}

export function buildStatusCommand(gardenRunner: string): string {
  // The status pane is primarily signal-driven: refreshStatusPane() sends
  // SIGUSR1 after every mutation (new worker, project switch, kill, etc.)
  // which interrupts the `sleep & wait` immediately. A 5s background poll
  // catches process status changes (working/idle/exited) that have no
  // event source.
  //
  // On signal, the trap immediately displays a pre-rendered status snapshot
  // (written by refreshDashboard) for instant visual feedback. The header
  // var is already updated by the mutation, so _header is skipped on
  // signal-triggered iterations. The full status poll then refines the
  // display with live process detection.
  const sf = STATUS_RENDERED_FILE;
  // Build the braille character class for sed replacement (all spinner frames)
  const brailleClass = `[${SPINNER_FRAMES.join("")}]`;
  // Shell array literal of spinner frames
  const framesArr = SPINNER_FRAMES.map(f => `'${f}'`).join(" ");
  return [
    `printf '\\033[H\\033[2J\\033[3J'`,
    `sf='${sf}'`,
    `sig=0`,
    `trap 'printf "\\033[H\\033[2J\\033[3J"; cat "$sf" 2>/dev/null; echo; sig=1' USR1`,
    `prev=""`,
    `spin_frames=(${framesArr})`,
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
    // When a worker is "working", animate the spinner at ~120ms.
    // After ~5s of animation (42 frames), break for a full status refresh.
    `  if printf '%s' "$cur" | grep -q 'working'; then`,
    `    sc=0;`,
    `    while [ $sc -lt 42 ]; do`,
    `      sleep 0.12 & wait $! 2>/dev/null;`,
    `      if [ $sig -eq 1 ]; then break; fi;`,
    `      sc=$((sc + 1));`,
    `      si=$((sc % ${SPINNER_FRAMES.length}));`,
    // eval to index the shell array by variable
    `      eval "sf_char=\\$\\{spin_frames[\\$si]\\}";`,
    `      animated=$(printf '%s' "$cur" | sed "s/${brailleClass}/$sf_char/g");`,
    `      printf '\\033[H\\033[2J\\033[3J%s\\n' "$animated";`,
    `    done;`,
    `  else`,
    `    sleep 5 & wait $! 2>/dev/null;`,
    `  fi;`,
    `done`,
  ].join("\n");
}

export function refreshStatusPane(opts?: RefreshOptions): void {
  const state = opts?.state ?? readDashState();
  if (!state.statusPaneId) return;
  try {
    const pid = getPanePid(state.statusPaneId);
    if (pid) process.kill(parseInt(pid, 10), "SIGUSR1");
  } catch { /* pane gone or process exited */ }
}

/**
 * Full dashboard refresh: updates header var instantly, writes a
 * pre-rendered status snapshot for the status pane to display on
 * signal, then signals the status pane. Call after every mutation.
 */
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
