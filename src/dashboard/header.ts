// Dashboard header and status bar: renders active project context (left)
// and garden build version (right) in the tmux status line.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SESSIONS_DIR, loadConfig, tryGetProject, plotsMap, isPlotFocused } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxOutput, getPanePid, getPaneTitle, getFirstPaneId, windowExists, setPaneVar, getPaneSize } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { findWorkerByName, updateWorkerFields, readRegistry, batchUpdateWorkerFields } from "./registry.js";
import { currentBranch, getWorkerBaseBranch } from "./git.js";
import { renderQuickStatus } from "../commands/status.js";
import { triggerProjectPoll } from "./poller.js";
import { log } from "./log.js";
import { unreadAlertCount, formatRightBar, addAlert, readAlerts } from "./alerts.js";
import { workerWindowName as workerWin, parseWorkerWindow } from "./window-names.js";
import { maybeRefreshUsage, renderUsagePane } from "./usage.js";
import { resolveGardenRunner } from "./create.js";
import { resolvePlotStatus, type PlotState } from "./plot-status.js";

const STATUS_RENDERED_FILE = path.join(SESSIONS_DIR, "status.rendered");
const USAGE_RENDERED_FILE = path.join(SESSIONS_DIR, "usage.rendered");
const PLOT_STRIP_TEMPLATE_FILE = path.join(SESSIONS_DIR, "plot-strip.template");
// Sentinel in the plot-strip template file; the status pane's animation loop
// substitutes it with the current spinner frame each tick.
const PLOT_SPINNER_SENTINEL = "__GSP__";

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
    [["-t", target, "status-interval", "30"], "status-interval"],
    // Window options — suppress window names for all windows in this session
    [["-t", mainWindow, "window-status-current-format", ""], "window-status-current-format"],
    [["-t", mainWindow, "window-status-format", ""], "window-status-format"],
    [["-t", mainWindow, "pane-border-status", "top"], "pane-border-status"],
    [["-t", mainWindow, "pane-border-format",
      "#{?@garden_name, #{@garden_name}#{?@garden_plot, #[fg=colour244]\u2500\u2500 #{@garden_plot}#[default],}#{?@garden_task, - #{@garden_task},} ,}"], "pane-border-format"],
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

function formatLeft(
  activeProject: string | null,
  activePlot: string | null,
  config: ReturnType<typeof loadConfig>,
): string {
  if (!activeProject) return " no projects";
  const projectConfig = config.projects[activeProject];
  const repoPath = projectConfig?.path ?? "";
  const branch = repoPath ? (currentBranch(repoPath) ?? "main") : "main";
  const plotPrefix = activePlot ? `${activePlot} #[fg=colour244]\u203a#[default] ` : "";
  return ` ${plotPrefix}#[bold]${activeProject}#[default]  ${branch} `;
}

// ---------------------------------------------------------------------------
// Right side: alert badge (when unread) + garden build version
// ---------------------------------------------------------------------------

function formatRight(): string {
  return formatRightBar(unreadAlertCount());
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

  // Pane-border vars must be set before setBarVars's refresh-client -S, or the border waits for the next status-interval tick.
  if (state.statusPaneId) {
    const { display, template } = buildPlotStrip(config, state.activePlot);
    setPaneVar(state.statusPaneId, "garden_name", display);
    setPaneVar(state.statusPaneId, "garden_plot", "");
    writePlotStripTemplate(template);
  }

  const left = formatLeft(state.activeProject, state.activePlot, config);
  const right = formatRight();
  setBarVars(left, right);
}

const PLOT_ICONS: Record<Exclude<PlotState, "idle">, string> = {
  failing: "✖",  // heavy x
  asking:  "⚑",  // flag
  merged:  "✓",  // check
  working: PLOT_SPINNER_SENTINEL,
};
const PLOT_COLORS: Record<Exclude<PlotState, "idle" | "working">, string> = {
  failing: "red",
  asking:  "yellow",
  merged:  "green",
};

// Circles mirror the worker focus marker rendered directly below this pane.
// Returns both the display string (spinner resolved to the current frame for
// immediate paint) and a template string (sentinel in place of the spinner)
// that the status pane loop re-bakes each animation tick.
function buildPlotStrip(
  config: ReturnType<typeof loadConfig>,
  activePlot: string | null,
): { display: string; template: string } {
  const entries = Object.entries(plotsMap(config)).filter(([, plot]) => isPlotFocused(plot));
  if (entries.length === 0) return { display: "", template: "" };

  const registry = readRegistry();
  const segments = entries.map(([name, plot]) => {
    const isActive = name === activePlot;
    const status = resolvePlotStatus(plot, registry);
    return formatPlotSegment(name, isActive, status);
  });
  const template = segments.join("  ");
  const frame = SPINNER_FRAMES[Math.floor(Date.now() / 200) % SPINNER_FRAMES.length];
  const display = template.split(PLOT_SPINNER_SENTINEL).join(frame);
  return { display, template };
}

function formatPlotSegment(name: string, isActive: boolean, status: PlotState): string {
  const circle = isActive ? "●" : "○";
  if (status === "idle") {
    return isActive
      ? `#[bold]${circle} ${name}#[default]`
      : `#[fg=colour244]${circle} ${name}#[default]`;
  }
  const icon = PLOT_ICONS[status];
  if (status === "working") {
    // Keep active/inactive bold/dim on circle+name; spinner stays bright so
    // "something's happening" reads at a glance even on unselected plots.
    return isActive
      ? `#[bold]${circle} ${icon} ${name}#[default]`
      : `#[fg=colour244]${circle}#[default] ${icon} #[fg=colour244]${name}#[default]`;
  }
  const color = PLOT_COLORS[status];
  const style = isActive ? `fg=${color},bold` : `fg=${color}`;
  return `#[${style}]${circle} ${icon} ${name}#[default]`;
}

function writePlotStripTemplate(template: string): void {
  try {
    const tmp = `${PLOT_STRIP_TEMPLATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, template);
    fs.renameSync(tmp, PLOT_STRIP_TEMPLATE_FILE);
  } catch { /* sessions dir not yet created; best effort */ }
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
    tmux("refresh-client", "-S");
  } catch { /* no client attached or session gone */ }
}

// Suppresses window-name leakage in the tmux status bar's center strip. ~200ms for ~16 windows — callers schedule after user-visible paints.
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

// Status/usage panes are passive sleep loops that swallow keystrokes on focus-in; bounce to the right column (`select-pane -R` is layout-relative so it survives swaps).
export function installInputGuard(state: DashboardState): void {
  if (!state.statusPaneId || !state.usagePaneId) return;
  const condition = `#{||:#{==:#{pane_id},${state.statusPaneId}},#{==:#{pane_id},${state.usagePaneId}}}`;
  try {
    tmux("set-hook", "-t", DASHBOARD_SESSION, "pane-focus-in",
      `if-shell -F "${condition}" "select-pane -R"`);
  } catch { /* hooks may not be supported on very old tmux */ }
}

// ---------------------------------------------------------------------------
// Claude hook handler
// ---------------------------------------------------------------------------

// Locate a worker's pane regardless of whether it's currently visible in the
// right slot or parked in a hidden window. Used by the hook handler to read
// the live tmux pane title (which Claude sets via terminal escape sequences
// and which doubles as a "what is this worker doing" summary).
function findWorkerPaneId(project: string, worker: string): string | null {
  const windowName = workerWin(project, worker);
  const state = readDashState();
  if (state.activeWindowName === windowName && state.activePaneId) {
    return state.activePaneId;
  }
  if (windowExists(windowName)) {
    return getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  }
  return null;
}

// Claude Code passes hook input as JSON on stdin; best-effort, returns {} on any failure.
function readHookInput(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

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

  const input = readHookInput();

  // Branch on the Claude Code event: see STATUS.md for the full transition table.
  const fields: Partial<Pick<import("./registry.js").WorkerEntry,
    "claudeStatus" | "lastHookAt" | "prState" | "task">> = {
    lastHookAt: Date.now(),
  };

  if (event === "sessionstart") {
    // resume/compact fire mid-turn (auto-compact in particular) and must not clobber working/asking; see STATUS.md.
    const source = typeof input.source === "string" ? input.source : "";
    if (source === "resume" || source === "compact") {
      const existing = findWorkerByName(workerInfo.project, workerInfo.worker);
      const cs = existing?.claudeStatus;
      if (cs !== "working" && cs !== "asking") {
        fields.claudeStatus = "ready";
      }
    } else {
      fields.claudeStatus = "ready";
    }
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
  } else if (event === "notification" || event === "pretooluse") {
    // Accept "working" (normal path) or "idle" (self-heal: a user-input
    // tool firing is proof of active turn, so idle status is stale).
    const existing = findWorkerByName(workerInfo.project, workerInfo.worker);
    const cs = existing?.claudeStatus;
    if (cs === "working" || cs === "idle") {
      fields.claudeStatus = "asking";
    } else {
      log.info("hook", "mid-turn asking hook skipped (non-working, non-idle)", {
        worker: workerInfo.worker,
        data: { project: workerInfo.project, event, claudeStatus: cs },
      });
    }
  } else if (event === "posttooluse") {
    // asking → working is the primary path (user answered, Claude resumes).
    // idle → working is a self-heal: a PostToolUse arriving while idle means
    // the turn is still active and our state is stale; trust the event.
    const existing = findWorkerByName(workerInfo.project, workerInfo.worker);
    const cs = existing?.claudeStatus;
    if (cs === "asking" || cs === "idle") {
      fields.claudeStatus = "working";
    }
  } else {
    // Unknown event — log and bail.
    log.warn("hook", "unknown claude hook event", {
      worker: workerInfo.worker,
      data: { project: workerInfo.project, event },
    });
    return;
  }

  // Capture the live pane title as the worker's task summary, when available.
  // Claude sets the title via terminal escape sequences as it works; reading
  // it here gives the registry an updated "what is this worker doing" string.
  // Title may be missing right at session start (no activity yet) or during
  // the brief window before Claude has set it after UserPromptSubmit — in
  // both cases we leave the previous task field intact.
  const paneId = findWorkerPaneId(workerInfo.project, workerInfo.worker);
  if (paneId) {
    const title = getPaneTitle(paneId);
    if (title) fields.task = title;
  }

  try {
    updateWorkerFields(workerInfo.project, workerInfo.worker, fields);
  } catch (err) {
    log.warn("hook", "failed to update worker for hook event", {
      worker: workerInfo.worker,
      data: { project: workerInfo.project, event, error: String(err) },
    });
  }

  // Info only when something actually moved: a lifecycle event (sessionstart /
  // prompt / stop) or a claudeStatus flip. Raw posttooluse/pretooluse that
  // don't change state are heartbeats — demoted to debug so the default log
  // level shows signal, not the per-tool-call stream.
  const isLifecycle = event === "sessionstart" || event === "prompt" || event === "stop";
  const stateChanged = fields.claudeStatus !== undefined || fields.prState !== undefined;
  const level = isLifecycle || stateChanged ? "info" : "debug";
  log[level]("hook", "claude hook", {
    worker: workerInfo.worker,
    data: {
      project: workerInfo.project,
      event,
      claudeStatus: fields.claudeStatus,
      prStateCleared: fields.prState === undefined && event === "prompt",
      ...(event === "sessionstart" && typeof input.source === "string"
        ? { source: input.source }
        : {}),
    },
  });

  // On stop, if the worktree has commits ahead of base, mark the worker as
  // pending review and poke the poller FIFO. The mark distinguishes "Stop
  // hook just fired with new commits" (review eligible) from "worker has
  // been idle for a month with stale commits" (must not review). Without
  // this, any FIFO poke would launch a review on every idle worker that
  // happens to have commits — a direct violation of STATUS.md invariant 2.
  if (event === "stop") {
    markPendingReviewIfCommitsAhead(workerInfo.project, workerInfo.worker);
    maybeRefreshUsage(resolveGardenRunner());
  }

  refreshDashboard();
}

function markPendingReviewIfCommitsAhead(projectName: string, workerName: string): void {
  const project = tryGetProject(projectName);
  if (!project) return;
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return;
  const baseBranch = getWorkerBaseBranch(entry, project.path);
  const cwd = process.cwd();
  try {
    // git rev-list --count <base>..HEAD — counts commits ahead of base.
    // Returns "0" if no commits ahead, a positive number otherwise.
    const out = execFileSync("git", ["rev-list", "--count", `origin/${baseBranch}..HEAD`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ahead = parseInt(out, 10);
    if (Number.isFinite(ahead) && ahead > 0) {
      updateWorkerFields(projectName, workerName, { pendingReviewAt: Date.now() });
      triggerProjectPoll(projectName);
      log.info("hook", "stop hook marked pending review (commits ahead of base)", {
        worker: workerName,
        data: { project: projectName, baseBranch, commitsAhead: ahead },
      });
    }
  } catch (err) {
    const errStr = String(err).slice(0, 200);
    log.warn("hook", "skipped poller poke (git check failed)", {
      worker: workerName,
      data: { project: projectName, baseBranch, error: errStr },
    });
    // Surface silent breakage: base branch drift is the primary way this
    // catch fires in practice — without an alert, the worker looks idle
    // forever and nobody notices the review cycle isn't running.
    if (!hasRecentWorkerAlert(projectName, workerName, "base-drift")) {
      addAlert({
        level: "warn",
        source: "worker",
        project: projectName,
        worker: workerName,
        message: `Worker ${workerName}: cannot check commits against origin/${baseBranch} — base branch may be missing on origin or the worktree may be broken. Review cycle is stalled. [base-drift]`,
      });
    }
  }
}

// Dedup: only fire a given "base-drift" alert once per worker per hour. The
// Stop hook fires on every end-of-turn, so a persistently broken base would
// otherwise spam the alert queue. The tag in the message is the dedup key.
function hasRecentWorkerAlert(
  projectName: string,
  workerName: string,
  tag: string,
  withinMs = 60 * 60 * 1000,
): boolean {
  try {
    const cutoff = Date.now() - withinMs;
    return readAlerts().alerts.some(a =>
      a.source === "worker" &&
      a.project === projectName &&
      a.worker === workerName &&
      a.message.includes(`[${tag}]`) &&
      new Date(a.ts).getTime() > cutoff,
    );
  } catch {
    return false;
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
  const parsed = parseWorkerWindow(windowName);
  if (!parsed) return;
  const { project, worker } = parsed;
  const entry = findWorkerByName(project, worker);
  if (!entry) return;
  const wasWorking = entry.claudeStatus === "working";
  try {
    updateWorkerFields(project, worker, {
      claudeStatus: "exited",
      ...(wasWorking ? { interruptedWhileWorking: true } : {}),
    });
  } catch { /* best effort */ }
  log.info("hook", "pane-died → exited", {
    worker,
    data: { project, windowName, interrupted: wasWorking },
  });
  refreshDashboard();
}

// ---------------------------------------------------------------------------
// tmux pane-title-changed handler
// ---------------------------------------------------------------------------

// tmux fires pane-title-changed whenever a pane's title is set via escape
// sequences. Claude Code updates the title continuously as it works, so this
// gives us live task summaries without polling. We receive the window name
// (to identify the worker) and pane ID (to read the current title).
export function handleTitleChanged(windowName: string | undefined, paneId: string | undefined): void {
  if (!windowName || !paneId) return;

  // Identify the worker — either from the hidden window name or, if the
  // worker is swapped into the visible right slot, from the active state.
  let project: string | undefined;
  let worker: string | undefined;

  const parsed = parseWorkerWindow(windowName);
  if (parsed) {
    ({ project, worker } = parsed);
  } else {
    const state = readDashState();
    if (state.activePaneId === paneId && state.activeWindowName) {
      const activeParsed = parseWorkerWindow(state.activeWindowName);
      if (activeParsed) {
        ({ project, worker } = activeParsed);
      }
    }
  }

  if (!project || !worker) return;

  const title = getPaneTitle(paneId);
  if (!title) return;

  // Skip if unchanged
  const entry = findWorkerByName(project, worker);
  if (!entry || entry.task === title) return;

  try {
    updateWorkerFields(project, worker, { task: title });
  } catch { return; }

  // Update pane border if this worker is in the visible right slot
  const state = readDashState();
  if (state.activePaneId === paneId) {
    setPaneVar(paneId, "garden_task", title);
  }

  writeQuickStatus();
}

// ---------------------------------------------------------------------------
// Status pane command builder
// ---------------------------------------------------------------------------

export function buildStatusCommand(gardenRunner: string): string {
  const sf = STATUS_RENDERED_FILE;
  const pst = PLOT_STRIP_TEMPLATE_FILE;
  const sent = PLOT_SPINNER_SENTINEL;
  const brailleClass = `[${SPINNER_FRAMES.join("")}]`;
  const caseBranches = SPINNER_FRAMES.map((f, i) => `${i}) sf_char='${f}';;`).join(" ");
  // Event-driven status pane loop:
  //   - SIGUSR1 from refreshStatusPane() interrupts the wait and re-renders.
  //   - The render reads the pre-baked file written by writeQuickStatus().
  //   - When a spinner is on screen, animate it locally; otherwise block.
  //   - There is no recurring re-check, no safety-net sleep, no fallback poll.
  //     Per STATUS.md invariant 6, every transition is event-triggered.
  //   - The plot strip (top bar) is animated here too — its template file
  //     carries a sentinel that this loop substitutes with the current frame
  //     on each tick, then writes to tmux @garden_name.
  return [
    `printf '\\033[H\\033[2J\\033[3J'`,
    `sf='${sf}'`,
    `pst='${pst}'`,
    `sig=0`,
    // Trap stays narrow: one $(cat) only. A heavier trap (e.g. also reloading
    // $pst) stacks SIGCHLD events from extra subshells on top of the inner
    // loop's `wait $_sp`, which can wedge bash so USR1 stops being delivered.
    `trap '_t=$(cat "$sf" 2>/dev/null); printf "\\033[H%s\\033[J" "$_t"; prev="$_t"; sig=1' USR1`,
    `prev=""`,
    `pt_tpl=""`,
    `fc=0`,
    `while true; do`,
    `  if [ $sig -eq 1 ]; then`,
    // Signal trap already displayed the pre-rendered content and set prev.
    `    cur="$prev";`,
    `    sig=0;`,
    `  else`,
    `    cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1 | awk '{printf "%s\\033[K\\n", $0}');`,
    `    if [ "$cur" != "$prev" ]; then`,
    `      printf '\\033[H%s\\033[J' "$cur";`,
    `      prev="$cur";`,
    `    fi;`,
    `  fi;`,
    // Reload pt_tpl outside the trap. Outer loop runs once per USR1 wake or
    // per 60s of continuous animation, so this is one cat per ~animation cycle.
    `  pt_tpl=""; [ -r "$pst" ] && pt_tpl=$(cat "$pst" 2>/dev/null);`,
    // Animate if either the pane content or the plot strip has a live spinner.
    `  has_cs=0; has_ps=0;`,
    `  if printf '%s' "$cur" | grep -q '${brailleClass}'; then has_cs=1; fi;`,
    `  case "$pt_tpl" in *"${sent}"*) has_ps=1 ;; esac;`,
    `  if [ $has_cs -eq 1 ] || [ $has_ps -eq 1 ]; then`,
    `    sc=0;`,
    `    while [ $sc -lt 500 ]; do`,
    // SIGUSR1 interrupts `wait`; kill the sleep, then `wait` again to reap it
    // synchronously — else bash prints "PID Terminated: 15 sleep ..." into the pane.
    `      sleep 0.12 & _sp=$!; wait $_sp 2>/dev/null; kill $_sp 2>/dev/null; wait $_sp 2>/dev/null;`,
    `      if [ $sig -eq 1 ]; then break; fi;`,
    `      sc=$((sc + 1));`,
    `      fc=$((fc + 1));`,
    `      si=$((fc % ${SPINNER_FRAMES.length}));`,
    `      case $si in ${caseBranches} esac;`,
    // Partial per-line repaint via awk — full-pane redraw every frame visibly flickers static lines.
    // Pipe form (printf | awk) instead of `awk <<<"$cur"`; the here-string's
    // hidden temp-file fork compounds with USR1 trap forks and contributed
    // to the wedge that motivated the trap-narrowing above.
    `      if [ $has_cs -eq 1 ]; then`,
    `        printf '%s\\n' "$cur" | awk -v b='${brailleClass}' -v f="$sf_char" '$0 ~ b { gsub(b, f); printf "\\033[%d;1H%s", NR, $0 }';`,
    `      fi;`,
    // Must be pane-level: setPaneVar's pane scope shadows session-level writes.
    `      if [ $has_ps -eq 1 ]; then`,
    `        tmux set-option -p -t "$TMUX_PANE" @garden_name "\${pt_tpl//${sent}/$sf_char}" 2>/dev/null;`,
    `      fi;`,
    `    done;`,
    `  else`,
    // Block until refreshStatusPane() sends SIGUSR1; 86400 is a 24h backstop.
    // Same kill+wait-reap pattern as the spinner sleep above.
    `    sleep 86400 & _sp=$!; wait $_sp 2>/dev/null; kill $_sp 2>/dev/null; wait $_sp 2>/dev/null;`,
    `  fi;`,
    `done`,
  ].join("\n");
}

export function buildUsageCommand(_gardenRunner: string): string {
  const uf = USAGE_RENDERED_FILE;
  // Simpler than buildStatusCommand: SIGUSR1 trap repaints the pre-baked file.
  // The 24h sleep is a backstop; kill+wait-reap keeps bash from printing an
  // async "PID Terminated: 15 sleep ..." notice after each signal.
  return [
    `printf '\\033[H\\033[2J\\033[3J'`,
    `uf='${uf}'`,
    `render() { _t=$(cat "$uf" 2>/dev/null); printf '\\033[H%s\\033[J' "$_t"; }`,
    `trap 'render' USR1`,
    `render`,
    `while true; do sleep 86400 & _sp=$!; wait $_sp 2>/dev/null; kill $_sp 2>/dev/null; wait $_sp 2>/dev/null; done`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Refresh helpers
// ---------------------------------------------------------------------------

// Shared SIGUSR1 helper — refreshStatusPane and refreshUsagePane delegate here.
function signalPane(paneId: string): void {
  try {
    const pid = getPanePid(paneId);
    if (pid) process.kill(parseInt(pid, 10), "SIGUSR1");
  } catch { /* pane gone or process exited */ }
}

export function refreshStatusPane(opts?: RefreshOptions): void {
  const state = opts?.state ?? readDashState();
  if (!state.statusPaneId) return;
  signalPane(state.statusPaneId);
}

export function refreshUsagePane(opts?: RefreshOptions): void {
  const state = opts?.state ?? readDashState();
  if (!state.usagePaneId) return;
  signalPane(state.usagePaneId);
}

export function refreshDashboard(opts?: RefreshOptions): void {
  // Paint first (writeQuickStatus/writeUsageRendered signal their panes inline);
  // tmux-heavy suppressWindowNames + refreshWorkerTasks run after so latency stays off plot switches.
  updateHeaderVar(opts);
  writeQuickStatus(opts);
  writeUsageRendered(opts);
  suppressWindowNames();
  refreshWorkerTasks();
}

// Lean refresh for worker cycling: skip header/tasks/usage since only the status marker moves.
export function refreshDashboardCycle(opts?: RefreshOptions): void {
  writeQuickStatus(opts);
}

// Lean refresh for plot cycling: plot strip + status only. Skips usage (account-wide,
// not per-plot), suppressWindowNames, and refreshWorkerTasks — the next hook/poller event picks them up.
export function refreshDashboardPlotCycle(opts?: RefreshOptions): void {
  updateHeaderVar(opts);
  writeQuickStatus(opts);
}

// Refresh all workers' task fields from their live tmux pane titles. This
// catches tasks set by Claude during work — the hook handler only captures
// the title at hook time, but Claude updates the pane title continuously as
// it works. By refreshing on every dashboard update (which piggybacks on
// existing hook events), we keep all workers' tasks current without polling.
function refreshWorkerTasks(): void {
  try {
    const registry = readRegistry();
    const updates: Array<{ project: string; workerName: string; fields: { task: string } }> = [];

    for (const [project, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        const paneId = findWorkerPaneId(project, entry.name);
        if (!paneId) continue;
        const title = getPaneTitle(paneId);
        if (title && title !== entry.task) {
          updates.push({ project, workerName: entry.name, fields: { task: title } });
        }
      }
    }

    if (updates.length > 0) {
      batchUpdateWorkerFields(updates);
    }
  } catch { /* best effort — don't block dashboard refresh */ }
}

// Floor lines for the status pane: the tallest rendered height among all plots
// (first 5 projects only). Each project renders as a header + one line per
// worker (or "(no workers)"); adjacent projects are separated by a blank line;
// the pane has a top/bottom blank. Using rendered height — not just project
// count — means switching from a bigger-by-workers plot doesn't cause a shrink.
function statusPaneFloorLines(): number {
  try {
    const plots = plotsMap(loadConfig());
    const reg = readRegistry();
    let max = 0;
    for (const plot of Object.values(plots)) {
      const projects = plot.projects.slice(0, 5);
      if (projects.length === 0) continue;
      let bodySum = 0;
      for (const name of projects) {
        const workers = reg.workers[name] ?? [];
        bodySum += Math.max(1, workers.length);
      }
      const N = projects.length;
      const lines = 2 * N + 1 + bodySum; // top(1)+headers(N)+bodies+seps(N-1)+bottom(1)
      if (lines > max) max = lines;
    }
    return max;
  } catch { return 0; }
}

function writeQuickStatus(opts?: RefreshOptions): void {
  try {
    const state = opts?.state ?? readDashState();
    const rendered = renderQuickStatus(state, opts?.windowNames);
    const tmpFile = `${STATUS_RENDERED_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, rendered);
    fs.renameSync(tmpFile, STATUS_RENDERED_FILE);
    if (state.statusPaneId) {
      // +1 for the pane-border-status top row, which is included in pane_height
      // but not in the rendered line count.
      const h = Math.max(statusPaneFloorLines(), rendered.split("\n").length) + 1;
      const cur = getPaneSize(state.statusPaneId);
      resizeAndSignal(state.statusPaneId, h, cur?.height ?? null);
    }
  } catch { /* best effort */ }
}

function writeUsageRendered(opts?: RefreshOptions): void {
  try {
    const state = opts?.state ?? readDashState();
    const cur = state.usagePaneId ? getPaneSize(state.usagePaneId) : null;
    const rendered = renderUsagePane(Date.now(), cur?.width);
    const tmpFile = `${USAGE_RENDERED_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, rendered);
    fs.renameSync(tmpFile, USAGE_RENDERED_FILE);
    if (state.usagePaneId) {
      // +1 for the pane-border-status top row.
      const h = rendered.split("\n").length + 1;
      resizeAndSignal(state.usagePaneId, h, cur?.height ?? null);
    }
  } catch { /* best effort */ }
}

function resizeAndSignal(paneId: string, newH: number, curH: number | null): void {
  if (curH == null || newH > curH) {
    // Grow first: else taller content scrolls its top rows off the still-small pane buffer.
    try { tmux("resize-pane", "-t", paneId, "-y", String(newH)); } catch { /* ignore */ }
    try { tmux("clear-history", "-t", paneId); } catch { /* ignore */ }
    try { tmux("refresh-client", "-S"); } catch { /* ignore */ }
    signalPane(paneId);
    return;
  }
  if (newH < curH) {
    // Signal before shrink: trap paints short content into the still-large pane (\033[J
    // clears the surplus); reverse order briefly shows cropped OLD content in the new pane.
    signalPane(paneId);
    try { tmux("resize-pane", "-t", paneId, "-y", String(newH)); } catch { /* ignore */ }
    try { tmux("clear-history", "-t", paneId); } catch { /* ignore */ }
    return;
  }
  signalPane(paneId);
}
