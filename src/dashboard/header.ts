// Dashboard header and status bar: renders active project context (left)
// and garden build version (right) in the tmux status line.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SESSIONS_DIR, loadConfig, tryGetProject } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxOutput, getPanePid } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { findWorkerByName, updateWorkerFields } from "./registry.js";
import { resolveBaseBranch } from "./git.js";
import { renderQuickStatus } from "../commands/status.js";
import { GARDEN_VERSION } from "../version.js";
import { triggerProjectPoll } from "./poller.js";
import { log } from "./log.js";

const STATUS_RENDERED_FILE = path.join(SESSIONS_DIR, "status.rendered");

// ---------------------------------------------------------------------------
// Worker identity from cwd
// ---------------------------------------------------------------------------

function workerFromCwd(): { project: string; worker: string } | null {
  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  const prefix = path.join(home, ".garden", "worktrees") + path.sep;
  if (!cwd.startsWith(prefix)) return null;
  const parts = cwd.slice(prefix.length).split(path.sep);
  if (parts.length < 2) return null;
  return { project: parts[0], worker: parts[1] };
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
// Header update — left/right bar vars, no process detection.
// ---------------------------------------------------------------------------

export function printHeader(): void {
  updateHeaderVar();
}

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
  // The reviewer also runs `claude -p` from inside the worktree, so its hooks
  // fire from the same cwd. We disambiguate via env var: launchReview() sets
  // GARDEN_REVIEWER=1, and reviewer hook fires never reach the registry path.
  if (process.env.GARDEN_REVIEWER === "1") return;

  const workerInfo = workerFromCwd();
  if (!workerInfo) {
    refreshDashboard();
    return;
  }

  // Three-way branch on the Claude Code event:
  //   sessionstart → claudeStatus = "ready"   (fresh worker, Claude loaded)
  //   prompt       → claudeStatus = "working" (and clear stale `merged` prState)
  //   stop         → claudeStatus = "idle"    (and poke poller if commits exist)
  const fields: Partial<Pick<import("./registry.js").WorkerEntry,
    "claudeStatus" | "lastHookAt" | "prState">> = {
    lastHookAt: Date.now(),
  };

  if (event === "sessionstart") {
    fields.claudeStatus = "ready";
  } else if (event === "prompt") {
    fields.claudeStatus = "working";
    // Clear merged prState on the next prompt — invariant 4 ("merged" is sticky
    // until new input). The hook handler is the only place this clear happens.
    const existing = findWorkerByName(workerInfo.project, workerInfo.worker);
    if (existing?.prState === "merged") {
      fields.prState = undefined;
    }
  } else if (event === "stop") {
    fields.claudeStatus = "idle";
  } else {
    // Unknown event — log and bail. The spec only handles sessionstart/prompt/stop.
    log.warn("hook", "unknown claude hook event", {
      worker: workerInfo.worker,
      data: { project: workerInfo.project, event },
    });
    return;
  }

  try {
    updateWorkerFields(workerInfo.project, workerInfo.worker, fields);
  } catch (err) {
    log.warn("hook", "failed to update worker for hook event", {
      worker: workerInfo.worker,
      data: { project: workerInfo.project, event, error: String(err) },
    });
  }

  // Structured diagnostic trail for "missed event" debugging.
  log.info("hook", "claude hook", {
    worker: workerInfo.worker,
    data: {
      project: workerInfo.project,
      event,
      claudeStatus: fields.claudeStatus,
      prStateCleared: fields.prState === undefined && event === "prompt",
    },
  });

  // On stop, if the worktree has commits ahead of base, poke the project's
  // poller FIFO so review starts immediately. This is the worker→reviewing
  // path: the poller wakes, sees claudeStatus="idle" with commits, and
  // launches the reviewer.
  if (event === "stop") {
    pokePollerIfCommitsAhead(workerInfo.project, workerInfo.worker);
  }

  refreshDashboard();
}

function pokePollerIfCommitsAhead(projectName: string, workerName: string): void {
  try {
    const project = tryGetProject(projectName);
    if (!project) return;
    const baseBranch = resolveBaseBranch(project.path, project);
    const cwd = process.cwd();
    // git rev-list --count <base>..HEAD — counts commits ahead of base.
    // Returns "0" if no commits ahead, a positive number otherwise.
    const out = execFileSync("git", ["rev-list", "--count", `${baseBranch}..HEAD`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ahead = parseInt(out, 10);
    if (Number.isFinite(ahead) && ahead > 0) {
      triggerProjectPoll(projectName);
      log.info("hook", "stop hook poked poller (commits ahead of base)", {
        worker: workerName,
        data: { project: projectName, baseBranch, commitsAhead: ahead },
      });
    }
  } catch (err) {
    // Common: not a git dir, base branch missing, etc. The poller will
    // recover on the next event source — do not fall back to a poll.
    log.info("hook", "skipped poller poke (git check failed)", {
      worker: workerName,
      data: { project: projectName, error: String(err).slice(0, 200) },
    });
  }
}

// ---------------------------------------------------------------------------
// tmux pane-died handler
// ---------------------------------------------------------------------------

// tmux fires pane-died with the window name. We parse out project + worker,
// look up the registry entry, and write claudeStatus="exited". No-op when
// the window name does not match a worker pattern (reviewer windows, garden
// panes) or when the registry entry is missing (bootstrap-failure race).
export function handlePaneDied(windowName: string | undefined): void {
  if (!windowName) return;
  const match = windowName.match(/^_(.+)-worker-(.+)$/);
  if (!match) return;
  const [, project, worker] = match;
  const entry = findWorkerByName(project, worker);
  if (!entry) return;
  try {
    updateWorkerFields(project, worker, { claudeStatus: "exited" });
  } catch { /* best effort */ }
  log.info("hook", "pane-died → exited", {
    worker,
    data: { project, windowName },
  });
  refreshDashboard();
}

// ---------------------------------------------------------------------------
// Status pane command builder
// ---------------------------------------------------------------------------

export function buildStatusCommand(gardenRunner: string): string {
  const sf = STATUS_RENDERED_FILE;
  const brailleClass = `[${SPINNER_FRAMES.join("")}]`;
  const caseBranches = SPINNER_FRAMES.map((f, i) => `${i}) sf_char='${f}';;`).join(" ");
  // Event-driven status pane loop:
  //   - SIGUSR1 from refreshStatusPane() interrupts the wait and re-renders.
  //   - The render reads the pre-baked file written by writeQuickStatus().
  //   - When a spinner is on screen, animate it locally; otherwise block.
  //   - There is no recurring re-check, no safety-net sleep, no fallback poll.
  //     Per STATUS.md invariant 6, every transition is event-triggered.
  return [
    `printf '\\033[H\\033[2J\\033[3J'`,
    `sf='${sf}'`,
    `sig=0`,
    `trap '_t=$(cat "$sf" 2>/dev/null); printf "\\033[H%s\\n\\033[J" "$_t"; prev="$_t"; sig=1' USR1`,
    `prev=""`,
    `fc=0`,
    `while true; do`,
    `  if [ $sig -eq 1 ]; then`,
    // Signal trap already displayed the pre-rendered content and set prev.
    // Reuse it as cur to skip the status subprocess and go straight into
    // the animation loop.
    `    cur="$prev";`,
    `    sig=0;`,
    `  else`,
    `    cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1 | awk '{printf "%s\\033[K\\n", $0}');`,
    `    if [ "$cur" != "$prev" ]; then`,
    `      printf '\\033[H%s\\n\\033[J' "$cur";`,
    `      prev="$cur";`,
    `    fi;`,
    `  fi;`,
    // Animate spinner when any worker has a braille spinner character.
    `  if printf '%s' "$cur" | grep -q '${brailleClass}'; then`,
    `    sc=0;`,
    `    while [ $sc -lt 500 ]; do`,
    `      sleep 0.08 & wait $! 2>/dev/null;`,
    `      if [ $sig -eq 1 ]; then break; fi;`,
    `      sc=$((sc + 1));`,
    `      fc=$((fc + 1));`,
    `      si=$((fc % ${SPINNER_FRAMES.length}));`,
    `      case $si in ${caseBranches} esac;`,
    `      animated=$(printf '%s' "$cur" | sed "s/${brailleClass}/$sf_char/g");`,
    `      printf '\\033[H%s\\n\\033[J' "$animated";`,
    `    done;`,
    `  else`,
    // Block until a SIGUSR1 from refreshStatusPane() wakes us. The trap
    // interrupts the wait, the next loop iteration re-renders. No timer.
    // 86400 = 24h, large enough to be effectively infinite for an idle pane.
    `    sleep 86400 & wait $! 2>/dev/null;`,
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
