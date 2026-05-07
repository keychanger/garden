// Dashboard header and status bar: renders active project context (left)
// and garden build version (right) in the tmux status line. Also owns the
// pane-died and pane-title-changed handlers and the dashboard-refresh
// orchestration. The Claude Code hook dispatcher (handleClaudeHook) lives
// in hook-dispatcher.ts — it must NOT live here, because hooks/default.ts
// statically imports header.ts for findWorkerPaneId/refreshDashboard, and
// header.ts importing workflows/index.ts (which the dispatcher needs)
// would close the init cycle that previously crashed every Claude Code
// hook. Keep this file workflows-free.
import path from "node:path";
import { SESSIONS_DIR, loadConfig, tryGetProject, plotsMap, isPlotFocused } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxOutput, getPanePid, getPaneTitle, getFirstPaneId, windowExists, setPaneVar, getPaneSize, listAllWindowNames } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { findWorkerByName, updateWorkerFields, readRegistry, batchUpdateWorkerFields, type WorkerRegistry } from "./registry.js";
import { atomicWriteFile } from "./atomic-write.js";
import { currentBranch } from "./git.js";
import { renderQuickStatus } from "../commands/status.js";
import { log } from "./log.js";
import { unreadAlertCount, formatRightBar } from "./alerts.js";
import { workerWindowName as workerWin, parseWorkerWindow } from "./window-names.js";
import { renderUsagePane } from "./usage.js";
import { resolvePlotStatus, type PlotState } from "./plot-status.js";

const STATUS_RENDERED_FILE = path.join(SESSIONS_DIR, "status.rendered");
const USAGE_RENDERED_FILE = path.join(SESSIONS_DIR, "usage.rendered");
const PLOT_STRIP_TEMPLATE_FILE = path.join(SESSIONS_DIR, "plot-strip.template");
// Sentinel in the plot-strip template file; the status pane's animation loop
// substitutes it with the current spinner frame each tick.
const PLOT_SPINNER_SENTINEL = "__GSP__";

interface RefreshOptions {
  state?: DashboardState;
  windowNames?: string[];
  config?: ReturnType<typeof loadConfig>;
  registry?: WorkerRegistry;
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
  const trellisSummary = formatTrellisSummary(activeProject);
  return ` ${plotPrefix}#[bold]${activeProject}#[default]  ${branch}${trellisSummary} `;
}

// Append a compact trellis summary to the left status segment when the
// active project has any trellis vine. Per TRELLIS.md "Bottom bar":
//   garden | main | trellises: auth-rewrite (4/30, drifting), session-cleanup (\u2713)
// Vines listed in plant order. Aligned vines marked \u2713; drifting shows
// iteration/budget; flagged shows \u2691; budget-exhausted shows !. Truncates
// with \u2026 when too wide.
const TRELLIS_SUMMARY_MAX = 60;
function formatTrellisSummary(projectName: string): string {
  const entries = readRegistry().workers[projectName] ?? [];
  const vines = entries.filter(e => e.workflow === "trellis");
  if (vines.length === 0) return "";

  const segments = vines.map(v => {
    const name = v.trellisName ?? "?";
    if (v.failingReason === "trellis-flagged") return `${name} (\u2691)`;
    if (v.failingReason === "iteration-budget") return `${name} (!)`;
    if (v.failingReason === "stagnation") return `${name} (~)`;
    if (v.trellisAligned) return `${name} (\u2713)`;
    const iter = v.trellisIteration ?? 0;
    const max = v.trellisMaxIterations ?? 30;
    return `${name} (${iter}/${max}, drifting)`;
  });
  let body = segments.join(", ");
  if (body.length > TRELLIS_SUMMARY_MAX) {
    body = body.slice(0, TRELLIS_SUMMARY_MAX - 1) + "\u2026";
  }
  return `  #[fg=colour244]|#[default] trellises: ${body}`;
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
  const config = opts?.config ?? loadConfig();

  // Pane-border vars must be set before setBarVars's refresh-client -S, or the border waits for the next status-interval tick.
  if (state.statusPaneId) {
    const { display, template } = buildPlotStrip(config, state.activePlot, opts?.registry);
    // Write template BEFORE setPaneVar so a racing bash animation tick reads
    // the new template (not the old one) and does not clobber the strip back
    // to the previous plot — see the per-frame reload in buildStatusCommand.
    writePlotStripTemplate(template);
    setPaneVar(state.statusPaneId, "garden_name", display);
    setPaneVar(state.statusPaneId, "garden_plot", "");
  }

  const left = formatLeft(state.activeProject, state.activePlot, config);
  const right = formatRight();
  setBarVars(left, right);
}

const PLOT_ICONS: Record<Exclude<PlotState, "idle">, string> = {
  failing: "✖",  // heavy x
  asking:  "⚑",  // flag
  done:    "✓",  // check — terminal cleanup signal
  working: PLOT_SPINNER_SENTINEL,
};
const PLOT_COLORS: Record<Exclude<PlotState, "idle" | "working">, string> = {
  failing: "red",
  asking:  "yellow",
  done:    "green",
};

// Circles mirror the worker focus marker rendered directly below this pane.
// Returns both the display string (spinner resolved to the current frame for
// immediate paint) and a template string (sentinel in place of the spinner)
// that the status pane loop re-bakes each animation tick.
function buildPlotStrip(
  config: ReturnType<typeof loadConfig>,
  activePlot: string | null,
  cachedRegistry?: WorkerRegistry,
): { display: string; template: string } {
  const entries = Object.entries(plotsMap(config)).filter(([, plot]) => isPlotFocused(plot));
  if (entries.length === 0) return { display: "", template: "" };

  const registry = cachedRegistry ?? readRegistry();
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
    atomicWriteFile(PLOT_STRIP_TEMPLATE_FILE, template);
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
function suppressWindowNames(cachedWindowNames?: string[]): void {
  try {
    const windows = cachedWindowNames
      ? cachedWindowNames.join("\n")
      : tmuxOutput("list-windows", "-t", DASHBOARD_SESSION, "-F", "#{window_name}");
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

// Locate a worker's pane regardless of whether it's currently visible in the
// right slot or parked in a hidden window. Used by the default hook handler
// to read the live tmux pane title (which Claude sets via terminal escape
// sequences and which doubles as a "what is this worker doing" summary), and
// by the dashboard's task-refresh paths (handleTitleChanged, refreshWorkerTasks).
export function findWorkerPaneId(project: string, worker: string): string | null {
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
  } catch (err) {
    // Lock contention. Logging here surfaces real registry contention so the
    // operator can correlate "stuck claudeStatus" with lock pressure instead
    // of guessing the cause.
    log.warn("hook", "pane-died update failed", {
      worker,
      data: { project, error: String(err) },
    });
  }
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
  } catch (err) {
    log.warn("hook", "pane-title update failed", {
      worker,
      data: { project, error: String(err) },
    });
    return;
  }

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
    // Re-read pt_tpl per frame so a plot change picked up via writePlotStripTemplate
    // takes effect within ~120ms — without this, the cached template clobbers
    // the JS-set @garden_name back to the previous plot until the next USR1.
    // $(<file) is a bash builtin (no fork, no SIGCHLD), so this stays clear of
    // the trap-wedge that motivated the trap-narrowing above.
    `      if [ -r "$pst" ]; then`,
    `        _ptn=$(<"$pst");`,
    `        if [ "$_ptn" != "$pt_tpl" ]; then`,
    `          pt_tpl="$_ptn";`,
    `          case "$pt_tpl" in *"${sent}"*) has_ps=1 ;; *) has_ps=0 ;; esac;`,
    `        fi;`,
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
  // Read each shared input once and thread it through the cascade — without
  // this, a single refresh re-reads loadConfig() ~3x, readRegistry() ~3x, and
  // tmux list-windows ~(N projects + 1) times. Hot path: hooks fire one full
  // refreshDashboard per Claude tool call.
  const shared: RefreshOptions = {
    state: opts?.state ?? readDashState(),
    windowNames: opts?.windowNames ?? listAllWindowNames(),
    config: opts?.config ?? loadConfig(),
    registry: opts?.registry ?? readRegistry(),
  };
  // Paint first (writeQuickStatus/writeUsageRendered signal their panes inline);
  // tmux-heavy suppressWindowNames + refreshWorkerTasks run after so latency stays off plot switches.
  updateHeaderVar(shared);
  writeQuickStatus(shared);
  writeUsageRendered(shared);
  suppressWindowNames(shared.windowNames);
  refreshWorkerTasks(shared.registry);
}

// Lean refresh for worker cycling: skip header/tasks/usage since only the status marker moves.
export function refreshDashboardCycle(opts?: RefreshOptions): void {
  writeQuickStatus(opts);
}

// Lean refresh for plot cycling: plot strip + status only. Skips usage (account-wide,
// not per-plot), suppressWindowNames, and refreshWorkerTasks — the next hook/poller event picks them up.
export function refreshDashboardPlotCycle(opts?: RefreshOptions): void {
  const shared: RefreshOptions = {
    state: opts?.state ?? readDashState(),
    windowNames: opts?.windowNames,
    config: opts?.config ?? loadConfig(),
    registry: opts?.registry ?? readRegistry(),
  };
  updateHeaderVar(shared);
  writeQuickStatus(shared);
}

// Refresh all workers' task fields from their live tmux pane titles. This
// catches tasks set by Claude during work — the hook handler only captures
// the title at hook time, but Claude updates the pane title continuously as
// it works. By refreshing on every dashboard update (which piggybacks on
// existing hook events), we keep all workers' tasks current without polling.
function refreshWorkerTasks(cachedRegistry?: WorkerRegistry): void {
  try {
    const registry = cachedRegistry ?? readRegistry();
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
function statusPaneFloorLines(
  cachedConfig?: ReturnType<typeof loadConfig>,
  cachedRegistry?: WorkerRegistry,
): number {
  try {
    const plots = plotsMap(cachedConfig ?? loadConfig());
    const reg = cachedRegistry ?? readRegistry();
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
    const rendered = renderQuickStatus(state, opts?.windowNames, opts?.config, opts?.registry);
    atomicWriteFile(STATUS_RENDERED_FILE, rendered);
    if (state.statusPaneId) {
      // +1 for the pane-border-status top row, which is included in pane_height
      // but not in the rendered line count.
      const h = Math.max(statusPaneFloorLines(opts?.config, opts?.registry), rendered.split("\n").length) + 1;
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
    atomicWriteFile(USAGE_RENDERED_FILE, rendered);
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
