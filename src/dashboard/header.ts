// Dashboard header and status bar: renders active project context (left)
// and garden build version (right) in the tmux status line. Also owns the
// pane-died and pane-title-changed handlers and the dashboard-refresh
// orchestration. The Claude Code hook dispatcher (handleClaudeHook) lives in
// hook-dispatcher.ts. Keep this file workflows-free: it is imported by the hot
// hook path, while workflows/index.ts retains every poller state handler.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, loadConfig, tryGetProject, plotsMap, isPlotFocused, logColorKeyForProject } from "../config.js";
import { logColorTmux } from "../log-palette.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxBatch, getPanePid, getPaneTitle, getFirstPaneId, windowExists, setPaneVar, getPaneSize, listAllWindowNames, listSessionPaneTitles, cleanPaneTitle, type PaneInfo } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { findWorkerByName, updateWorkerFields, removeWorker, readRegistry, batchUpdateWorkerFields, type WorkerRegistry } from "./registry.js";
import { atomicWriteFile } from "./atomic-write.js";
import { currentBranchFast, worktreeExists } from "./git.js";
import { renderQuickStatus } from "../commands/status.js";
import { log } from "./log.js";
import { unreadAlertCount, formatRightBar, statusBarStyle } from "./alerts.js";
import { renderAlertsPane } from "../commands/alerts.js";
import { workerWindowName as workerWin, parseWorkerWindow, parseWorkerSuffix } from "./window-names.js";
import { renderUsagePane } from "./usage.js";
import { formatConversationPane } from "./conversation.js";
import { getHarnessCore, resolveWorkerActivity } from "./harness/core.js";
import { resolvePlotStatus, type PlotState } from "./plot-status.js";

export const STATUS_RENDERED_FILE = path.join(SESSIONS_DIR, "status.rendered");
// Diagnostic dump path for the status pane's live $cur (see _diag-status).
export const STATUS_CUR_DUMP_FILE = path.join(SESSIONS_DIR, "status.cur.dump");
const USAGE_RENDERED_FILE = path.join(SESSIONS_DIR, "usage.rendered");
const HISTORY_RENDERED_FILE = path.join(SESSIONS_DIR, "history.rendered");
const ALERTS_RENDERED_FILE = path.join(SESSIONS_DIR, "alerts.rendered");
const PLOT_STRIP_TEMPLATE_FILE = path.join(SESSIONS_DIR, "plot-strip.template");
// Sentinel in the plot-strip template file; the status pane's animation loop
// substitutes it with the current spinner frame each tick.
const PLOT_SPINNER_SENTINEL = "__GSP__";

interface RefreshOptions {
  state?: DashboardState;
  windowNames?: string[];
  config?: ReturnType<typeof loadConfig>;
  registry?: WorkerRegistry;
  // Route pane resizes through resizeAndSignalNoRefresh (no clear-history /
  // refresh-client -S) — set by the _client-resized re-bake, which must never
  // disturb copy-mode scrolling the way a full refresh did (a10642c).
  copyModeSafe?: boolean;
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
    // Left segment renders the plot strip on the status pane (gated on
    // @garden_name). Worker/shell panes prefix the label with a \u25cf in the
    // project's log color (gated on @garden_color, set alongside
    // @garden_clock via setPaneProjectColor) so the border echoes the
    // color the project carries in `garden logs` — the one place the
    // pane otherwise names the worker, never the project; tmux expands the
    // nested #{@garden_color} inside #[fg=...] before parsing the style. The
    // trailing segment renders a right-aligned wall clock on the right pane
    // \u2014 worker or shell \u2014 (gated on @garden_clock, set in
    // restoreWorkerPaneVars, focusShell, and at worker/shell pane creation).
    // %H:%M is strftime-expanded by tmux on each status-interval tick, so it
    // advances on tmux's own timer with no process. Styled bold green to
    // mirror the `garden` title, wrapped in spaces and capped with two border
    // dashes so the border runs to the right corner exactly like the left
    // edge frames `garden`. Every style in this format MUST stay comma-free
    // (#[fg=green]#[bold], not #[fg=green,bold]) \u2014 a comma inside a
    // #{?...} conditional is parsed as the true/false separator and silently
    // blanks the segment.
    [["-t", mainWindow, "pane-border-format",
      "#{?@garden_name, #{?@garden_color,#[fg=#{@garden_color}]\u25cf#[default] ,}#{@garden_name}#{?@garden_plot, #[fg=colour244]\u2500\u2500 #{@garden_plot}#[default],}#{?@garden_task, - #{@garden_task},} ,}#{?@garden_clock,#[align=right]#[fg=green]#[bold] %H:%M #[default]\u2500\u2500,}"], "pane-border-format"],
  ];
  for (const [args] of opts) {
    try { tmux("set-option", ...args); } catch { /* ignore */ }
  }
}

// Paint the project's log color into a pane border: sets @garden_color so the
// pane-border-format above renders a ● in that color before the pane label.
// swap-pane does not carry pane-level user options, so call this everywhere
// @garden_clock is (re)applied to a worker or project-shell pane.
export function setPaneProjectColor(
  paneId: string,
  project: string,
  config?: ReturnType<typeof loadConfig>,
): void {
  const key = logColorKeyForProject(project, config);
  const color = key ? logColorTmux(key) : null;
  if (color) setPaneVar(paneId, "garden_color", color);
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
  const branch = repoPath ? (currentBranchFast(repoPath) ?? "main") : "main";
  const plotPrefix = activePlot ? `${activePlot} #[fg=colour244]\u203a#[default] ` : "";
  const trellisSummary = formatTrellisSummary(activeProject);
  return ` ${plotPrefix}#[bold]${activeProject}#[default]  ${branch}${trellisSummary} `;
}

// Append a compact trellis summary to the left status segment when the
// active project has any trellis vine. Per WORKFLOWS.md "Bottom bar":
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
    const t = v.trellis;
    const name = t?.name ?? "?";
    if (v.failingReason === "trellis-flagged") return `${name} (\u2691)`;
    if (v.failingReason === "iteration-budget") return `${name} (!)`;
    if (v.failingReason === "stagnation") return `${name} (~)`;
    if (t?.aligned) return `${name} (\u2713)`;
    const iter = t?.iteration ?? 0;
    const max = t?.maxIterations ?? 30;
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

function formatRight(opts?: RefreshOptions): string {
  return formatRightBar(unreadAlertCount(), (opts?.state ?? readDashState()).buildBehind);
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
  const right = formatRight({ state });
  setBarVars(left, right, statusBarStyle(state.buildBehind));
}

const PLOT_ICONS: Record<Exclude<PlotState, "idle">, string> = {
  failing: "✖",  // heavy x
  // Same red failure signal, spinning: a failing worker being worked on.
  "failing-working": PLOT_SPINNER_SENTINEL,
  asking:  "⚑",  // flag
  done:    "✓",  // check — terminal cleanup signal
  working: PLOT_SPINNER_SENTINEL,
};
const PLOT_COLORS: Record<Exclude<PlotState, "idle" | "working">, string> = {
  failing: "red",
  "failing-working": "red",
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

// Every glyph in a segment MUST carry an explicit `fg=`. This strip is drawn as
// the status pane's pane-border-format, and tmux resolves a colorless glyph
// against the base cell it hands to format_draw — pane-border-style normally,
// but pane-active-border-style whenever the status pane is the active pane.
// Garden never overrides those, so the tmux default applies:
//   #{?pane_in_mode,fg=yellow,#{?synchronize-panes,fg=red,fg=green}}
// A colorless glyph therefore turned GREEN every time focus landed on the
// status pane (the mouse-lock bindings in hotkeys.ts select it before the
// pane-focus-in guard bounces focus away, so a click or wheel over the strip
// was enough) and yellow in copy-mode — reading as a `done` plot when the plot
// was merely working. `fg=default` is the color the border already resolved to
// in the common case, so pinning it preserves today's look and only removes the
// leak. Per DESIGN.md, green in this strip means `done` and nothing else.
function formatPlotSegment(name: string, isActive: boolean, status: PlotState): string {
  const circle = isActive ? "●" : "○";
  const neutral = isActive ? "fg=default,bold" : "fg=colour244";
  if (status === "idle") {
    return `#[${neutral}]${circle} ${name}#[default]`;
  }
  const icon = PLOT_ICONS[status];
  if (status === "working") {
    // The spinner shares the segment's neutral color rather than standing out
    // on its own: bright-on-active, flat grey on the plots you aren't in.
    return `#[${neutral}]${circle} ${icon} ${name}#[default]`;
  }
  const color = PLOT_COLORS[status];
  const style = isActive ? `fg=${color},bold` : `fg=${color}`;
  return `#[${style}]${circle} ${icon} ${name}#[default]`;
}

// Short-circuit when the template hasn't changed since the last write. The
// plot strip mutates only on plot add/remove/focus events; in steady state
// every refreshDashboard re-computes the same template. Skipping the
// atomicWriteFile (a write+rename pair of syscalls) when content is
// identity-equal to the last write keeps the per-hook cascade off disk.
let lastWrittenPlotStripTemplate: string | null = null;

function writePlotStripTemplate(template: string): void {
  if (template === lastWrittenPlotStripTemplate) return;
  if (renderedFileUnchanged(PLOT_STRIP_TEMPLATE_FILE, template)) {
    lastWrittenPlotStripTemplate = template;
    return;
  }
  try {
    atomicWriteFile(PLOT_STRIP_TEMPLATE_FILE, template, { durable: false });
    lastWrittenPlotStripTemplate = template;
  } catch { /* sessions dir not yet created; best effort */ }
}

// ---------------------------------------------------------------------------
// tmux variable helpers
// ---------------------------------------------------------------------------

// Skip the batched tmux client connect (one subprocess: 4 set-option +
// 1 refresh-client) when both bars match the last-applied values. The format strings (status-left /
// status-right pointing at @garden_left / @garden_right) only need to be set
// once per dashboard process — they don't drift unless tmux is restarted —
// so the entire block is safe to skip on identity match. Reset on dashboard
// process restart.
let lastBarLeft: string | null = null;
let lastBarRight: string | null = null;
let lastBarStyle: string | null = null;

function setBarVars(left: string, right: string, style: string): void {
  if (left === lastBarLeft && right === lastBarRight && style === lastBarStyle) return;
  try {
    const t = DASHBOARD_SESSION;
    // Ensure format strings point to the correct variables. Idempotent and
    // cheap — self-heals after CLI rebuilds without requiring dashboard restart.
    // One client connect for all five commands instead of five (setBarVars runs
    // on every refresh, so this is on the hook firehose + every nav).
    tmuxBatch(
      ["set-option", "-t", t, "status-left", "#{@garden_left}"],
      ["set-option", "-t", t, "status-right", "#{@garden_right}"],
      ["set-option", "-t", t, "@garden_left", left],
      ["set-option", "-t", t, "@garden_right", right],
      // Whole-bar color carries the build-staleness signal (statusBarStyle).
      // Batched with the rest so it costs no extra client connect.
      ["set-option", "-t", t, "status-style", style],
      ["refresh-client", "-S"],
    );
    lastBarLeft = left;
    lastBarRight = right;
    lastBarStyle = style;
  } catch { /* no client attached or session gone */ }
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
// right slot or parked in a hidden window. Used by the shared hook handler
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
// look up the registry entry, and write agentStatus="exited". No-op when
// the window name does not match a worker pattern (reviewer windows, garden
// panes) or when the registry entry is missing (bootstrap-failure race).
export function handlePaneDied(windowName: string | undefined): void {
  if (!windowName) return;
  const parsed = parseWorkerWindow(windowName);
  if (!parsed) return;
  const { project, worker } = parsed;
  const entry = findWorkerByName(project, worker);
  if (!entry) return;

  // Bootstrap-abort detection: the pane died before reaching Claude Code
  // (agentStatus still "loading" — the dispatch_loaded path in workers.ts
  // only flips this once Claude is running) AND no worktree exists on disk.
  // This is a never-bootstrapped worker — `_bootstrap-fail` should have
  // already removed the registry entry, but cover the path where bootstrap
  // crashed for an unrelated reason (segfault, OOM, operator ⌥x while the
  // script was mid-fetch). Without this, the entry persists as a ghost the
  // standard sweep can't clean (agentStatus would become "exited" below,
  // taking it out of the ghost rule's "loading" filter).
  if (entry.agentStatus === "loading"
      && (!entry.worktreePath || !worktreeExists(entry.worktreePath))) {
    try {
      removeWorker(project, worker);
      log.info("hook", "pane-died → removed (bootstrap aborted, no worktree)", {
        worker,
        data: { project, windowName },
      });
    } catch (err) {
      log.warn("hook", "pane-died removal failed", {
        worker,
        data: { project, error: String(err) },
      });
    }
    refreshDashboard();
    return;
  }

  const wasWorking = entry.agentStatus === "working";
  try {
    updateWorkerFields(project, worker, {
      agentStatus: "exited",
      ...(wasWorking ? { interruptedWhileWorking: true } : {}),
    });
  } catch (err) {
    // Lock contention. Logging here surfaces real registry contention so the
    // operator can correlate "stuck agentStatus" with lock pressure instead
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

  const entry = findWorkerByName(project, worker);
  if (!entry) return;

  // A harness that reads its own activity (HarnessCore.readActivity) is
  // authoritative — its pane title carries no summary, so a title event must
  // not touch the task. Codex's default terminal title renders `project-name`,
  // which falls back to the cwd basename: for a garden worktree that IS the
  // worker's own name, and writing it here stomped the transcript-derived
  // summary the hook and status-render paths had just set. Returning before
  // getPaneTitle also keeps such a worker's title events off the tmux fork.
  // Its task stays current via resolveWorkerActivity in applyAndLog and
  // refreshWorkerTasks, which is also where its pane border is refreshed.
  if (getHarnessCore(entry.harness).readActivity) return;

  const title = getPaneTitle(paneId);
  if (!title || entry.task === title) return;

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
  const sessionsDir = SESSIONS_DIR;
  const brailleClass = `[${SPINNER_FRAMES.join("")}]`;
  const caseBranches = SPINNER_FRAMES.map((f, i) => `${i}) sf_char='${f}';;`).join(" ");
  // Event-driven status pane loop:
  //   - SIGUSR1 from refreshStatusPane() interrupts the wait and re-renders.
  //   - The render reads the pre-baked file written by writeQuickStatus()
  //     — both the SIGUSR1 trap and the else-branch in the outer loop. No
  //     `garden status` shell-out per tick: that fork was a 50-150ms Node
  //     cold-start every time the spinner loop's outer cycle landed in the
  //     non-trap branch (every ~60s of continuous animation, plus on every
  //     wake when no signal arrived). The pre-baked file is the single
  //     source of truth.
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
    `cd='${STATUS_CUR_DUMP_FILE}'`,
    `sig=0`,
    // Trap stays narrow: one $(cat) only. A heavier trap (e.g. also reloading
    // $pst) stacks SIGCHLD events from extra subshells on top of the inner
    // loop's `wait $_sp`, which can wedge bash so USR1 stops being delivered.
    `trap '_t=$(cat "$sf" 2>/dev/null); printf "\\033[H%s\\033[J" "$_t"; prev="$_t"; sig=1' USR1`,
    // Diagnostic-only: dump the live $cur (what the spinner overlay repaints
    // from) on demand. Writes to a stable file so _diag-status can compare it
    // against the pre-baked file. printf %s avoids appending a trailing newline.
    `trap 'printf %s "$cur" > "$cd"' USR2`,
    `prev=""`,
    `pt_tpl=""`,
    `fc=0`,
    // diag: counter for the auto-detector (see below). Capped at 3 captures
    // per dashboard lifetime so the snapshot dir doesn't fill if the bug is
    // chronic. Reset on pane respawn.
    `diag_count=0`,
    `sd='${sessionsDir}'`,
    `while true; do`,
    `  if [ $sig -eq 1 ]; then`,
    // Signal trap already displayed the pre-rendered content and set prev.
    `    cur="$prev";`,
    `    sig=0;`,
    `  else`,
    // Read the pre-baked file directly (same source the SIGUSR1 trap uses).
    // The full-pane \033[J cleanup on the printf below handles content shrink;
    // no per-line \033[K postprocessing needed.
    `    cur=$(cat "$sf" 2>/dev/null);`,
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
    // -------- diag auto-detector (REMOVE WITH ALL OTHER diag- PLUMBING) --------
    // Detects the spinner-overlay duplicate-row bug: visible pane has two
    // adjacent identical non-blank lines that $cur does NOT have. Runs once
    // per outer-loop iteration (≤1/60s during continuous spinner). Capped at
    // 3 captures per dashboard lifetime via diag_count.
    //
    // Cost per check: 1 capture-pane + 2 awks. On detect: 1 date + 1 cat +
    // 1 list-panes + 1 background fork to dispatch the alert. All forks are
    // outside the inner spinner loop's `wait $_sp`, so they don't compete
    // with USR1 delivery — see the trap-narrowing comment above.
    `  if [ $diag_count -lt 3 ]; then`,
    `    _vis=$(tmux capture-pane -p -t "$TMUX_PANE" -J 2>/dev/null);`,
    `    if [ -n "$_vis" ]; then`,
    `      _vd=0; _cd=0;`,
    `      if printf '%s\\n' "$_vis" | awk 'NF && $0==prev {f=1; exit} {prev=$0} END {exit !f}'; then _vd=1; fi;`,
    `      if printf '%s\\n' "$cur" | awk 'NF && $0==prev {f=1; exit} {prev=$0} END {exit !f}'; then _cd=1; fi;`,
    `      if [ $_vd -eq 1 ] && [ $_cd -eq 0 ]; then`,
    `        diag_count=$((diag_count + 1));`,
    `        _ts=$(date +%s);`,
    `        _snap="$sd/diag-snap-$_ts-$diag_count.txt";`,
    `        {`,
    `          printf '## ts\\n%s\\n\\n## diag_count\\n%s\\n\\n## cur\\n%s\\n\\n## file\\n' "$_ts" "$diag_count" "$cur";`,
    `          cat "$sf" 2>/dev/null;`,
    `          printf '\\n## visible\\n%s\\n' "$_vis";`,
    `          printf '\\n## geometry\\n';`,
    `          tmux list-panes -t "$TMUX_PANE" -F '#{pane_id} w=#{pane_width} h=#{pane_height} top=#{pane_top}' 2>/dev/null;`,
    `        } > "$_snap";`,
    `        ${gardenRunner} dashboard _diag-alert "$_snap" 2>/dev/null &`,
    `      fi;`,
    `    fi;`,
    `  fi;`,
    // -------- end diag auto-detector --------
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

// History pane: SIGUSR1 repaint loop reading the pre-baked history.rendered.
// Unlike the usage pane, each repaint fully clears the screen AND scrollback
// (\033[2J\033[3J) before printing the whole conversation: the full clear
// prevents a shorter new line from leaving a longer previous line's tail on
// screen (the bleed-through other panes would otherwise show), and printing the
// whole conversation lets content taller than the pane scroll into tmux
// scrollback so the operator can scroll up through the full history.
export function buildHistoryCommand(_gardenRunner: string): string {
  const cf = HISTORY_RENDERED_FILE;
  return [
    `printf '\\033[H\\033[2J\\033[3J'`,
    `cf='${cf}'`,
    `render() { _t=$(cat "$cf" 2>/dev/null); printf '\\033[H\\033[2J\\033[3J%s' "$_t"; }`,
    `trap 'render' USR1`,
    `render`,
    `while true; do sleep 86400 & _sp=$!; wait $_sp 2>/dev/null; kill $_sp 2>/dev/null; wait $_sp 2>/dev/null; done`,
  ].join("\n");
}

// Alerts pane (⌥a): same passive SIGUSR1 repaint shape as the history pane —
// full clear + full print, so a shorter list can't leave a longer one's tail on
// screen and an overflowing list scrolls into tmux scrollback.
export function buildAlertsCommand(_gardenRunner: string): string {
  const af = ALERTS_RENDERED_FILE;
  return [
    `printf '\\033[H\\033[2J\\033[3J'`,
    `af='${af}'`,
    `render() { _t=$(cat "$af" 2>/dev/null); printf '\\033[H\\033[2J\\033[3J%s' "$_t"; }`,
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
  // tmux-heavy refreshWorkerTasks runs after so latency stays off plot switches;
  // when it discovers a new task the pane is re-baked from its updated snapshot
  // rather than showing the prior text until the next event.
  // Window names are suppressed at window-creation time (newDashboardWindow), so
  // there is no per-refresh window-name sweep here.
  updateHeaderVar(shared);
  writeQuickStatus(shared);
  writeUsageRendered(shared);
  writeHistoryRendered(shared);
  const refreshedRegistry = refreshWorkerTasks(shared.registry, shared.state);
  if (refreshedRegistry) writeQuickStatus({ ...shared, registry: refreshedRegistry });
}

// Lean refresh for worker cycling: skip header/tasks/usage since only the status marker moves.
export function refreshDashboardCycle(opts?: RefreshOptions): void {
  writeQuickStatus(opts);
  writeHistoryRendered(opts); // follow focus when cycling workers in ⌥h mode
}

// Re-bake the status pane so time-in-state elapsed suffixes advance without a
// state transition to drive them. The status pane is otherwise fully
// event-driven; the watchdog's 60s tick is the sole recurring caller, so a
// "reviewing 12m" row ticks to "13m" once a minute. Threads its inputs the same
// way refreshDashboard does — one registry read, one config load, one
// list-windows — so the 60s re-bake doesn't re-read the registry and fork
// git/tmux once per project. Deliberately status-only: it must not drive the
// header/usage/tasks tmux work on a fixed cadence. writeQuickStatus's content
// dedup (in-process cache + on-disk byte-compare) suppresses the write+signal
// when the baked text is byte-identical. The `working` spinner frame is baked
// FIXED (status.ts iconFor) and animated locally by the pane, so a busy fleet's
// bytes stay stable too — only a row whose time-in-state suffix ticks over
// (`reviewing 12m` -> `13m`) actually repaints on a given tick; a fleet with
// nothing time-tracked stays fully deduped.
export function refreshStatusElapsed(): void {
  const shared: RefreshOptions = {
    state: readDashState(),
    windowNames: listAllWindowNames(),
    config: loadConfig(),
    registry: readRegistry(),
  };
  writeQuickStatus(shared);
  // The alerts view (⌥a) has the same problem the status pane's time-in-state
  // suffixes do: its rows age ("4m" → "5m"), and an alert raised by a poller
  // reaches the store with no dashboard refresh behind it. This tick is the one
  // recurring driver, so it re-bakes here too — a no-op unless alerts is the
  // active view, and content-deduped even then.
  writeAlertsRendered(shared);
}

// Reset module-level write/idempotency caches. Intended for tests that
// instantiate the module once but exercise multiple "first-write" scenarios;
// production code shouldn't call this — caches reset naturally when the
// dashboard process restarts.
export function _resetHeaderCachesForTest(): void {
  lastWrittenPlotStripTemplate = null;
  lastWrittenQuickStatus = null;
  lastWrittenUsageRendered = null;
  lastWrittenHistory = null;
  lastWrittenAlerts = null;
  lastBarLeft = null;
  lastBarRight = null;
  cachedStatusWidth = null;
}

// Lean refresh for plot cycling: plot strip + status only. Skips usage (account-wide,
// not per-plot) and refreshWorkerTasks — the next hook/poller event picks them up.
export function refreshDashboardPlotCycle(opts?: RefreshOptions): void {
  const shared: RefreshOptions = {
    state: opts?.state ?? readDashState(),
    windowNames: opts?.windowNames,
    config: opts?.config ?? loadConfig(),
    registry: opts?.registry ?? readRegistry(),
  };
  updateHeaderVar(shared);
  writeQuickStatus(shared);
  writeHistoryRendered(shared); // follow focus when cycling plots in ⌥h mode
}

// Refresh all workers' task fields from whatever source their harness owns
// (resolveWorkerActivity — the live pane title for Claude Code, the transcript
// for Codex). This catches tasks set during work — the hook handler only
// captures the summary at hook time, but an agent updates it continuously as
// it works. By refreshing on every dashboard update (which piggybacks on
// existing hook events), we keep all workers' tasks current without polling.
//
// Batched: one tmux `list-panes -s -F` call yields every pane's
// (windowName, paneId, title) in a single fork. The previous shape ran
// findWorkerPaneId + getPaneTitle per worker — 2-3 tmux forks each, scaling
// linearly with worker count. Now constant: one fork regardless of N.
function refreshWorkerTasks(
  cachedRegistry?: WorkerRegistry,
  cachedState?: DashboardState,
): WorkerRegistry | null {
  try {
    const registry = cachedRegistry ?? readRegistry();
    const state = cachedState ?? readDashState();
    const panes = listSessionPaneTitles();
    if (panes.length === 0) return null;

    // Index by both window name (the parked-pane lookup) and pane id (the
    // active-window swap-pane lookup). A worker's pane is in its logical
    // hidden window when parked, but moves to the visible right slot via
    // swap-pane when focused — pane_id is the stable identifier across both.
    const byWindow = new Map<string, PaneInfo>();
    const byPaneId = new Map<string, string>();
    for (const p of panes) {
      if (!byWindow.has(p.windowName)) byWindow.set(p.windowName, p);
      byPaneId.set(p.paneId, p.rawTitle);
    }

    const updates: Array<{ project: string; workerName: string; fields: { task: string } }> = [];

    for (const [project, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        const logical = workerWin(project, entry.name);
        const activePaneId = state.activeWindowName === logical ? state.activePaneId : null;
        const raw = activePaneId ? byPaneId.get(activePaneId) : byWindow.get(logical)?.rawTitle;
        const summary = resolveWorkerActivity(entry, () => cleanPaneTitle(raw));
        // The registry may already hold this summary because the hook path
        // wrote it before this refresh. Keep the visible border synchronized
        // independently of whether a registry update is still needed.
        if (summary && activePaneId) setPaneVar(activePaneId, "garden_task", summary);
        if (summary && summary !== entry.task) {
          updates.push({ project, workerName: entry.name, fields: { task: summary } });
        }
      }
    }

    if (updates.length > 0) {
      batchUpdateWorkerFields(updates);
      const workers = Object.fromEntries(
        Object.entries(registry.workers).map(([project, entries]) => [
          project,
          entries.map(entry => {
            const update = updates.find(u => u.project === project && u.workerName === entry.name);
            return update ? { ...entry, ...update.fields } : entry;
          }),
        ]),
      );
      return { workers };
    }
    return null;
  } catch { /* best effort — don't block dashboard refresh */ }
  return null;
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

// Short-circuit caches for the rendered files. When the renderer produces the
// same string as the last write, both the atomicWriteFile (write+rename
// syscalls) and the signalPane SIGUSR1 are wasteful — the pane already shows
// this content. Steady-state hooks (PostToolUse storms, repeated Stop events)
// often regenerate identical output; this keeps the per-hook cascade quiet.
let lastWrittenQuickStatus: string | null = null;
let lastWrittenUsageRendered: string | null = null;

// Cross-process arm of the short-circuit. The lastWritten* caches above are
// module-level, so they are permanently cold in the one-shot hook.js / cli.js
// processes that drive most repaints — every hook fire would re-write and
// re-signal even when the content is byte-identical to what the pane already
// shows. Comparing the freshly rendered bytes against the on-disk file (a
// ~0.05ms read) recovers the skip across processes, avoiding the write+rename
// and, more importantly, the SIGUSR1 (signalPane forks tmux for the pane pid).
// The pane's own loop re-reads the file each cycle, so a skipped signal never
// leaves it stale for long. Returns false on a missing/unreadable file so the
// first write of a session still lands.
function renderedFileUnchanged(file: string, content: string): boolean {
  try {
    return fs.readFileSync(file, "utf-8") === content;
  } catch {
    return false;
  }
}

// The status pane width changes only on terminal/layout resize, so a short TTL
// lets writeQuickStatus cap rows to the pane width without forking a tmux size
// query on every hook-driven refresh, while still tracking a resize within ~1s.
const STATUS_PANE_WIDTH_TTL_MS = 1000;
let cachedStatusWidth: { paneId: string; width: number | undefined; at: number } | null = null;

function cachedStatusPaneWidth(paneId: string): number | undefined {
  const now = Date.now();
  if (cachedStatusWidth && cachedStatusWidth.paneId === paneId
      && now - cachedStatusWidth.at < STATUS_PANE_WIDTH_TTL_MS) {
    return cachedStatusWidth.width;
  }
  const width = getPaneSize(paneId)?.width;
  cachedStatusWidth = { paneId, width, at: now };
  return width;
}

function writeQuickStatus(opts?: RefreshOptions): void {
  try {
    const state = opts?.state ?? readDashState();
    // Width for row-capping, via a short TTL cache: the pane width changes only
    // on terminal/layout resize, so this avoids a tmux size fork on every no-op
    // refresh — the PostToolUse-storm path the dedup below exists to keep quiet.
    const width = state.statusPaneId ? cachedStatusPaneWidth(state.statusPaneId) : undefined;
    const rendered = renderQuickStatus(
      state, opts?.windowNames, opts?.config, opts?.registry, width,
    );
    if (rendered === lastWrittenQuickStatus) return;
    if (renderedFileUnchanged(STATUS_RENDERED_FILE, rendered)) {
      lastWrittenQuickStatus = rendered;
      return;
    }
    atomicWriteFile(STATUS_RENDERED_FILE, rendered, { durable: false });
    lastWrittenQuickStatus = rendered;
    if (state.statusPaneId) {
      // +1 for the pane-border-status top row, which is included in pane_height
      // but not in the rendered line count. Height is read fresh here (past the
      // dedup) so no-op refreshes still fork nothing.
      const h = Math.max(statusPaneFloorLines(opts?.config, opts?.registry), rendered.split("\n").length) + 1;
      const cur = getPaneSize(state.statusPaneId);
      const pin = opts?.copyModeSafe ? resizeAndSignalNoRefresh : resizeAndSignal;
      pin(state.statusPaneId, h, cur?.height ?? null);
    }
  } catch { /* best effort */ }
}

let lastWrittenHistory: string | null = null;
let lastWrittenAlerts: string | null = null;

// Repaint the history pane (bottom-left ⌥h mode) for the worker currently
// focused in the right slot. A cheap no-op unless history is the active garden
// mode — so the transcript parse stays off every unrelated refresh and never
// touches the per-tool-call hook firehose. Wired into every refresh entry point
// so the view follows focus across project/worker/plot navigation.
export function writeHistoryRendered(opts?: RefreshOptions): void {
  try {
    const state = opts?.state ?? readDashState();
    if (state.gardenPaneType !== "history" || !state.gardenShellPaneId) return;
    const size = getPaneSize(state.gardenShellPaneId);
    const width = size?.width ?? 60;
    const rendered = renderHistoryContent(state, width, opts?.registry);
    if (rendered === lastWrittenHistory) return;
    if (renderedFileUnchanged(HISTORY_RENDERED_FILE, rendered)) {
      lastWrittenHistory = rendered;
      return;
    }
    atomicWriteFile(HISTORY_RENDERED_FILE, rendered, { durable: false });
    lastWrittenHistory = rendered;
    signalPane(state.gardenShellPaneId);
  } catch { /* best effort */ }
}

// Bakes the ⌥a alerts view. Unread/read is split on state.alertsSeenMark — the
// pre-ack mark snapshotted on entry — so the view the operator is reading keeps
// showing what was new even though focusAlerts already cleared the badge.
//
// Deliberately NOT called from refreshDashboard, unlike its writeHistoryRendered
// sibling. refreshDashboard is in dist/hook.js's import closure, so a call here
// pulls renderAlertsPane (and commands/logs.ts, for wrapDetail) into the lean
// hook bundle — measured at +2.8KB on every hook fire's cold start, versus +260
// bytes when esbuild can tree-shake it out. The callers that actually matter
// live in the CLI bundle: focusAlerts (entry), refreshStatusElapsed (the
// watchdog's 60s tick, for row ages), rebakePanesOnResize (the view wraps to
// the pane width), and the `dashboard _refresh-alerts` route, which addAlert
// spawns for a newly raised alert so one arriving under an open view repaints
// at once rather than a tick later (refreshAlertsPane, alerts.ts — spawned
// rather than called for this same bundle reason, plus the header→alerts
// import cycle a direct call would close).
export function writeAlertsRendered(opts?: RefreshOptions): void {
  try {
    const state = opts?.state ?? readDashState();
    if (state.gardenPaneType !== "alerts" || !state.gardenShellPaneId) return;
    const width = getPaneSize(state.gardenShellPaneId)?.width ?? 60;
    const rendered = renderAlertsPane(width, state.alertsSeenMark, Date.now());
    if (rendered === lastWrittenAlerts) return;
    if (renderedFileUnchanged(ALERTS_RENDERED_FILE, rendered)) {
      lastWrittenAlerts = rendered;
      return;
    }
    atomicWriteFile(ALERTS_RENDERED_FILE, rendered, { durable: false });
    lastWrittenAlerts = rendered;
    signalPane(state.gardenShellPaneId);
  } catch { /* best effort */ }
}

// Keep enough exchanges that the full conversation is in scrollback; the pane
// renders all of them and lets tmux hold the overflow (the operator scrolls up
// for older turns — the render does not truncate to the visible height).
const HISTORY_MAX_TURNS = 40;

function dimLine(msg: string): string {
  return ` \x1b[2m${msg}\x1b[0m`;
}

function renderHistoryContent(
  state: DashboardState,
  width: number,
  cachedRegistry?: WorkerRegistry,
): string {
  let lines: string[];
  if (state.activePaneType !== "worker" || !state.activeWindowName || !state.activeProject) {
    lines = [dimLine("no active worker — focus one with ⌥w")];
  } else {
    const worker = parseWorkerSuffix(state.activeWindowName);
    const registry = cachedRegistry ?? readRegistry();
    const entry = worker
      ? registry.workers[state.activeProject]?.find(e => e.name === worker)
      : undefined;
    if (!entry) {
      lines = [dimLine("no active worker")];
    } else {
      // Transcript reading is harness-shaped: claude-code parses its JSONL
      // envelope, codex its rollout format. Route through the entry's adapter
      // so the ⌥h view works for any harness (claude-code stays byte-identical
      // — its adapter methods wrap the same conversation.ts functions).
      const core = getHarnessCore(entry.harness);
      const turns = core.readTurns(core.resolveTranscriptPath(entry), HISTORY_MAX_TURNS);
      if (turns.length === 0) {
        lines = [dimLine("no conversation yet")];
      } else {
        const status = entry.agentStatus === "working" ? "working"
          : entry.agentStatus === "asking" ? "asking" : undefined;
        lines = formatConversationPane(turns, { width, status });
      }
    }
  }
  return lines.join("\n");
}

function writeUsageRendered(opts?: RefreshOptions): void {
  try {
    const state = opts?.state ?? readDashState();
    const cur = state.usagePaneId ? getPaneSize(state.usagePaneId) : null;
    const rendered = renderUsagePane(Date.now(), cur?.width);
    if (rendered === lastWrittenUsageRendered) return;
    if (renderedFileUnchanged(USAGE_RENDERED_FILE, rendered)) {
      lastWrittenUsageRendered = rendered;
      return;
    }
    atomicWriteFile(USAGE_RENDERED_FILE, rendered, { durable: false });
    lastWrittenUsageRendered = rendered;
    if (state.usagePaneId) {
      // +1 for the pane-border-status top row.
      const h = rendered.split("\n").length + 1;
      const pin = opts?.copyModeSafe ? resizeAndSignalNoRefresh : resizeAndSignal;
      pin(state.usagePaneId, h, cur?.height ?? null);
    }
  } catch { /* best effort */ }
}

// Reconcile the status pane height to its current content on a terminal resize.
// writeQuickStatus normally re-pins the height, but only past its byte-identical
// short-circuit — so a bare terminal resize, which drifts the pane height via
// tmux's proportional redistribution yet changes no rendered content, is no
// longer self-healed by the next same-state hook (that was the cold-cache hook
// processes' accidental job before the cross-process dedup). The _client-resized
// handler calls this so the reconciliation rides the actual resize event, off
// the hot hook path. Repaints via SIGUSR1, never refresh-client, so it can't
// disturb copy-mode scrolling the way a full refresh did.
export function repinStatusPaneHeight(state: DashboardState): void {
  if (!state.statusPaneId) return;
  try {
    const rendered = fs.readFileSync(STATUS_RENDERED_FILE, "utf-8");
    const h = Math.max(statusPaneFloorLines(), rendered.split("\n").length) + 1;
    const cur = getPaneSize(state.statusPaneId)?.height ?? null;
    if (cur === h) return;
    resizeAndSignalNoRefresh(state.statusPaneId, h, cur);
  } catch { /* no rendered file yet, or pane gone — best effort */ }
}

// Same reconciliation for the usage pane, whose height is also content-derived
// (meter rows plus an optional health-tag row). Falls back to the caller's
// default height when no render exists yet (fresh session, meter disabled).
export function repinUsagePaneHeight(state: DashboardState, fallbackHeight: number): void {
  if (!state.usagePaneId) return;
  try {
    let h = fallbackHeight;
    try {
      h = fs.readFileSync(USAGE_RENDERED_FILE, "utf-8").split("\n").length + 1;
    } catch { /* no rendered file yet — pin to the default */ }
    const cur = getPaneSize(state.usagePaneId)?.height ?? null;
    if (cur === h) return;
    resizeAndSignalNoRefresh(state.usagePaneId, h, cur);
  } catch { /* pane gone — best effort */ }
}

// The _client-resized re-bake. The pre-baked pane content is width-shaped —
// status rows are capped to the pane width, usage meter bars scale to it, and
// the history/alerts views wrap to it — so a terminal resize leaves every
// baked file rendered for the OLD width until the next event-driven refresh,
// which an idle fleet may not produce for a long time (the "panes look wrong
// until I spawn a worker" failure). Re-render everything at the fresh widths
// here, on the resize event itself, then reconcile the heights that tmux's
// proportional redistribution drifted (the repin* pair covers the case where
// the content bytes didn't change, which the writers' dedup would skip).
// Everything routes through the copy-mode-safe signal path — never
// refresh-client — so a resize can't disturb copy-mode scrolling (a10642c).
// CLI-bundle only (like refreshStatusElapsed): not reachable from hook.js, so
// the alerts renderer stays tree-shaken out of the hook bundle.
export function rebakePanesOnResize(state: DashboardState, usageFallbackHeight: number): void {
  // The resize event is precisely the moment the TTL'd width cache goes stale;
  // bust it so writeQuickStatus re-reads the pane width unconditionally.
  cachedStatusWidth = null;
  const shared: RefreshOptions = {
    state,
    windowNames: listAllWindowNames(),
    config: loadConfig(),
    registry: readRegistry(),
    copyModeSafe: true,
  };
  writeQuickStatus(shared);
  writeUsageRendered(shared);
  writeHistoryRendered(shared);
  writeAlertsRendered(shared);
  repinStatusPaneHeight(state);
  repinUsagePaneHeight(state, usageFallbackHeight);
}

// resizeAndSignal's ordering (grow-then-signal / signal-then-shrink) without its
// refresh-client -S, so it stays copy-mode-safe on the resize event.
function resizeAndSignalNoRefresh(paneId: string, newH: number, curH: number | null): void {
  if (curH == null || newH > curH) {
    try { tmux("resize-pane", "-t", paneId, "-y", String(newH)); } catch { /* ignore */ }
    signalPane(paneId);
    return;
  }
  signalPane(paneId);
  try { tmux("resize-pane", "-t", paneId, "-y", String(newH)); } catch { /* ignore */ }
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
