// Shows project status: registered projects, active workers, and their states.
//
// Per STATUS.md, the registry is the single source of truth and there is one
// render path. This file reads agentStatus and prState from the registry,
// combines them via resolveWorkerStatus(), and renders. It does not call
// pgrep and does not read marker files. Before rendering, it refreshes
// worker task summaries from live tmux pane titles so the registry stays
// current between hook events.
import { loadConfig, getFocusedProjectNames, allPlotProjectNames, tryGetProject, getAutoContinueConfig } from "../config.js";
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { output, isTTY } from "../output.js";
import { readDashState, type DashboardState } from "../dashboard/state.js";
import { getWorkers, readRegistry, batchUpdateWorkerFields, compareWorkerFreshness, isWorkerStale, type WorkerRegistry } from "../dashboard/registry.js";
import { listHiddenWorkerWindows, windowExists, getFirstPaneId, getPaneTitle } from "../dashboard/tmux.js";
import { workerWindowName as workerWin, parseWorkerSuffix } from "../dashboard/window-names.js";
import { currentBranchFast } from "../dashboard/git.js";
import { diaryHasContent } from "../diary.js";
import { deriveCrew } from "../dashboard/crew.js";
import type { GardenConfig, ProjectConfig } from "../config.js";

// Display states from STATUS.md. These are the only values the renderer ever
// emits. `loading`/`ready`/`working`/`idle`/`exited` come from agentStatus
// (written by hooks). `reviewing`/`merge-pending`/`failing`/`merged`/`done`
// come from prState (written by the poller and the Stop hook). The combine
// function gives prState priority because it describes where the worker's
// *code* is.
export type ProcessStatus = "loading" | "ready" | "working" | "asking" | "idle" | "paused" | "exited";
type LifecycleStatus = "reviewing" | "merge-pending" | "resolving" | "ci-fixing" | "failing" | "merged" | "done";
type WorkerStatus = ProcessStatus | LifecycleStatus;

interface WorkerInfo {
  name: string;
  status: WorkerStatus;
  activity: string | null;
  active: boolean;
  // Epoch ms the worker last entered its current state — an agentStatus or
  // prState transition (registry.lastStateChangeAt). Drives the dim
  // time-in-state suffix on in-flight/blocked rows. Undefined for orphan
  // windows with no registry entry and for legacy entries that predate the
  // field, in which case the suffix is omitted.
  lastStateChangeAt?: number;
  // True when the worker is in the active/recent tier and nothing has touched
  // it in over WORKER_STALE_MS — the renderer dims the row. Other tiers
  // (blocked, new, in-flight, done) are never stale-dimmed.
  stale: boolean;
  failCount: number;
  // The branch this worker is pinned to merge into. Undefined for legacy
  // entries written before the field existed. The renderer compares it
  // against the project's current checkout and appends "→ <base>" when
  // they diverge — that mismatch is the leading indicator of the
  // "did not fast-forward after merge" alert pattern.
  baseBranch?: string;
  // Trellis-specific decoration fields. Populated only when
  // entry.workflow === "trellis"; default workers leave them undefined
  // and the renderer omits the bracket.
  trellis?: {
    name: string;
    iteration: number;
    maxIterations: number;
    driftCount: number;
    aligned: boolean;
    failingReason?: string;
  };
  // CI-fix decoration fields. Populated when the worker is currently in
  // `ci-fixing` (auto-fix in flight) or `failing` with reason `ci` (auto-fix
  // ran out of attempts). The renderer surfaces this so the operator sees
  // CI state inline rather than chasing alert badges.
  ci?: {
    fixing: boolean;
    failing: boolean;
    attempts?: number;
    budget?: number;
    failingSha?: string;
  };
}

interface ProjectStatusInfo {
  name: string;
  index: number;
  isActive: boolean;
  workers: WorkerInfo[];
  // Current branch checked out in the project's main directory. Shown next
  // to the project name in TTY render so off-base workers are visually
  // distinguishable at a glance.
  projectBranch?: string | null;
}

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const STATUS_ICONS: Record<WorkerStatus, string> = {
  loading:        "\u29D7",     // hourglass
  ready:          "\u25C7",     // open diamond
  working:        SPINNER_FRAMES[0],
  asking:         "\u2691",     // black flag — worker is blocked on operator input
  idle:           "\u25C6",     // filled diamond
  paused:         "\u2016",     // double vertical bar - operator-held (interrupted, awaiting redirect)
  reviewing:      "\u25CE",     // bullseye
  "merge-pending": "\u25F7",    // circle with right half - queued
  resolving:      "\u25D4",     // circle with upper-right quadrant - resolving
  "ci-fixing":    "\u25D5",     // circle with all but upper-left quadrant - ci-fix in flight
  failing:        "\u2716",     // heavy multiplication x
  merged:         "\u2713",     // check mark - transient post-merge beat (neutral color)
  done:           "\u2713",     // check mark - operator-actionable cleanup signal (bold green)
  exited:         "\u25CB",     // open circle
};

function iconFor(worker: WorkerInfo): string {
  // Bake a FIXED spinner frame (STATUS_ICONS.working === SPINNER_FRAMES[0]) for
  // a working row, not a Date.now()-derived one. The status pane animates the
  // frame locally at 0.12s by replacing the baked braille char, so a
  // time-varying baked frame was redundant — and worse, it churned the rendered
  // bytes every ~2s, defeating the cross-process byte-compare that skips the
  // write + SIGUSR1 when the fleet is unchanged (see writeQuickStatus).
  return STATUS_ICONS[worker.status];
}

// Refresh all workers' task fields from their live tmux pane titles. Called
// before rendering so the registry has current data even if no hook has fired
// recently (e.g. workers in the middle of a long work session). This keeps
// the registry as the source of truth — we update it, then render from it.
function refreshWorkerTasks(state: DashboardState): void {
  try {
    const registry = readRegistry();
    const updates: Array<{ project: string; workerName: string; fields: { task: string } }> = [];

    for (const [project, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        const windowName = workerWin(project, entry.name);
        let paneId: string | null = null;
        if (state.activeWindowName === windowName && state.activePaneId) {
          paneId = state.activePaneId;
        } else if (windowExists(windowName)) {
          paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
        }
        if (!paneId) continue;
        const title = getPaneTitle(paneId);
        if (title && title !== entry.task) {
          updates.push({ project, workerName: entry.name, fields: { task: title } });
        }
      }
    }

    if (updates.length > 0) batchUpdateWorkerFields(updates);
  } catch { /* best effort */ }
}

export async function status(args: string[]): Promise<void> {
  const allPlots = args.includes("--all");
  const config = loadConfig();
  const dashState = readDashState();
  // `--all` reports the deduplicated union of every plot's projects; without
  // it, only the active plot. The JSON output shape is identical either way.
  const names = allPlots
    ? allPlotProjectNames(config)
    : getFocusedProjectNames(config, dashState.activePlot);

  if (names.length === 0) {
    console.log("No projects added.");
    return;
  }
  const hasDashboard = dashboardExists();

  if (hasDashboard) refreshWorkerTasks(dashState);

  const statuses: ProjectStatusInfo[] = names.map((name, i) => {
    return {
      name,
      index: i + 1,
      isActive: dashState.activeProject === name,
      workers: hasDashboard ? collectWorkers(name, dashState) : [],
      projectBranch: resolveProjectBranch(name),
    };
  });

  if (!isTTY) {
    output(statuses);
    return;
  }

  const allWorkers = statuses.flatMap(p => p.workers);
  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = STATUS_WIDTH;
  const cols = process.stdout.columns || 120;
  const activityMax = Math.max(20, cols - (8 + nameWidth + 2 + statusWidth + 2));

  // One clock read per render so every row's elapsed suffix is consistent.
  const now = Date.now();
  const gateClosed = !getAutoContinueConfig(config).enabled;

  console.log("");
  for (let pi = 0; pi < statuses.length; pi++) {
    if (pi > 0) console.log("");
    const project = statuses[pi];
    const marker = project.isActive ? " \u25C4" : "";
    const name = project.isActive ? `\x1b[1;32m${project.name}\x1b[0m` : project.name;
    console.log(`  ${project.index}. ${name}${formatDiaryGlyph(project.name)}${marker}`);

    if (project.workers.length === 0) {
      console.log("    (no workers)");
    } else {
      const showAllBranches = projectHasBranchDivergence(project.workers, project.projectBranch);
      for (const worker of project.workers) {
        const focus = worker.active ? "\u25CF" : "\u25CB";
        const icon = iconFor(worker);
        const wname = worker.name.padEnd(nameWidth);
        const wstatus = formatStatus(worker).padEnd(statusWidth);
        const baseHint = formatBranchHint(worker.baseBranch, project.projectBranch, showAllBranches);
        const elapsed = formatTimeInState(worker.status, worker.lastStateChangeAt, now);
        const gate = formatGateSuffix(worker.status, gateClosed);
        const line = `    ${focus} ${icon} ${wname}  ${wstatus}${formatRowTail(worker, baseHint, activityMax)}${elapsed}${gate}`;
        const colored = colorizeRow(worker.status, line);
        console.log(worker.stale ? dimRow(colored) : colored);
      }
    }
  }
  console.log("");
}

function truncateActivity(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

const STATUS_WIDTH = 9; // "resolving" / "reviewing" are the widest

function formatStatus(worker: WorkerInfo): string {
  if (worker.status === "merge-pending") return "merging";
  return worker.status;
}

function colorizeRow(status: WorkerStatus, line: string): string {
  if (status === "asking") return `\x1b[1;33m${line}\x1b[0m`;
  if (status === "failing") return `\x1b[1;31m${line}\x1b[0m`;
  if (status === "done") return `\x1b[1;32m${line}\x1b[0m`;
  // paused is operator-controlled, not urgent — bold cyan marks it as a
  // deliberate hold, distinct from the yellow/red/green attention states.
  if (status === "paused") return `\x1b[1;36m${line}\x1b[0m`;
  return line;
}

// Render a status row dimmed (faint). Rows embed inner ANSI that ends in a full
// reset — the branch hint and the trellis iteration counter — so a
// naive `\x1b[2m…\x1b[0m` wrap would let the first inner reset cancel the faint
// attribute, half-brightening the rest of the row. Re-arm faint after every
// inner reset so the whole line stays dimmed. Only ever applied to active/recent
// rows, which colorizeRow leaves uncolored — the one colored active-band state,
// `paused`, is excluded from staleness (isWorkerStale) so a row-level color never
// reaches here to fight the faint.
export function dimRow(line: string): string {
  const FAINT = "\x1b[2m";
  const RESET = "\x1b[0m";
  return FAINT + line.split(RESET).join(RESET + FAINT) + RESET;
}

// Approximate terminal column width of one code point: 0 for combining marks,
// zero-width joiners, and variation selectors; 2 for East-Asian Wide/Fullwidth
// and all astral-plane code points (emoji, pictographs, astral CJK) so a wide
// glyph is never UNDERcounted — an undercounted wide glyph lets a capped row
// still wrap, the exact failure the cap prevents. Ambiguous-width BMP glyphs
// (the geometric status icons, ●/○, arrows, ✓/✗) count as 1, correct on a
// non-CJK terminal; the row cap's 2-column margin absorbs the rare terminal
// that renders a couple of them double-wide.
function codePointWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f)      // Hangul Jamo
      || (cp >= 0x2e80 && cp <= 0xa4cf)   // CJK radicals … Yi
      || (cp >= 0xac00 && cp <= 0xd7a3)   // Hangul syllables
      || (cp >= 0xf900 && cp <= 0xfaff)   // CJK compatibility ideographs
      || (cp >= 0xff00 && cp <= 0xff60)   // Fullwidth forms
      || (cp >= 0xffe0 && cp <= 0xffe6)   // Fullwidth signs
      || cp >= 0x1f000)                    // astral: emoji, pictographs, CJK ext
    return 2;
  return 1;
}

// Truncate `s` to at most `maxWidth` visible columns, preserving CSI escape
// sequences (zero-width) and closing with a reset so a color cut mid-run does
// not bleed into the next line. Visible width is summed via codePointWidth so
// wide glyphs are not undercounted. Status rows carry only CSI color codes
// (never OSC or bare ESC), so CSI-only handling is complete here. Used to
// hard-cap each row to the pane width: a row wider than the pane wraps onto a
// second terminal line, which desyncs the in-place repaint (the rendered line
// count no longer matches the displayed height) and corrupts the pane on the
// next refresh.
export function truncateToVisibleWidth(s: string, maxWidth: number): string {
  const CSI = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
  let out = "";
  let visible = 0;
  let sawEscape = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = CSI.exec(s.slice(i));
      if (m) { out += m[0]; sawEscape = true; i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i)!;
    const w = codePointWidth(cp);
    if (visible + w > maxWidth) return sawEscape ? out + "\x1b[0m" : out;
    out += String.fromCodePoint(cp);
    visible += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

// Combine agentStatus and prState into a single display state.
// Lifecycle states (reviewing, merge-pending, failing, merged, done) take
// priority because they describe where the worker's *code* is, not what
// Claude is doing right now. The hook handler is the only place that clears
// `merged`/`done` from prState (on UserPromptSubmit) — this function never
// mutates state.
export function resolveWorkerStatus(
  entry: { agentStatus?: string; prState?: string } | undefined,
): WorkerStatus {
  const pr = entry?.prState;
  if (pr === "reviewing" || pr === "merge-pending" || pr === "resolving" || pr === "ci-fixing" || pr === "failing" || pr === "merged" || pr === "done") {
    return pr;
  }
  const cs = entry?.agentStatus as ProcessStatus | undefined;
  // No agentStatus yet (e.g., entry just created without "loading"): show
  // "ready" as the safest neutral state.
  return cs ?? "ready";
}

// Distill the trellis fields off a registry entry into the WorkerInfo
// shape used by the renderer. Returns undefined for default-workflow
// workers — the bracket is omitted.
function ciInfoFor(entry?: {
  workflow?: string;
  prState?: string;
  failingReason?: string;
  failingSha?: string;
  ciFixAttempts?: number;
}): WorkerInfo["ci"] {
  if (!entry) return undefined;
  // Trellis vines already get a full bracket — don't double-decorate.
  if (entry.workflow === "trellis") return undefined;
  const inCiFix = entry.prState === "ci-fixing";
  const ciFailing = entry.prState === "failing" && entry.failingReason === "ci";
  if (!inCiFix && !ciFailing) return undefined;
  return {
    fixing: inCiFix,
    failing: ciFailing,
    attempts: entry.ciFixAttempts,
    budget: CI_FIX_BUDGET_DISPLAY,
    failingSha: entry.failingSha,
  };
}

// Display-only constant. Mirrors src/dashboard/poller-ci-fix.ts's CI_FIX_BUDGET.
// Kept inline to avoid commands/status.ts pulling in the poller graph.
const CI_FIX_BUDGET_DISPLAY = 3;

function trellisInfoFor(entry?: { workflow?: string; trellis?: { name: string; iteration?: number; maxIterations?: number; lastDrift?: string[]; lastVerdict?: string; aligned?: boolean }; failingReason?: string }): WorkerInfo["trellis"] {
  if (!entry || entry.workflow !== "trellis") return undefined;
  const t = entry.trellis;
  return {
    name: t?.name ?? "?",
    iteration: t?.iteration ?? 0,
    maxIterations: t?.maxIterations ?? 30,
    driftCount: t?.lastVerdict === "DRIFT" ? (t.lastDrift?.length ?? 0) : 0,
    aligned: t?.aligned === true,
    failingReason: entry.failingReason,
  };
}

// Format the CI bracket for a default-workflow row when the worker is in
// `ci-fixing` (auto-fix in flight) or `failing` with reason `ci` (auto-fix
// exhausted). Trellis vines route through formatTrellisBracket above and
// don't reach here. The bracket keeps a single leading space, so it sits one
// column left of the activity slot the trellis bracket now aligns to (see
// formatRowTail) — default CI rows are otherwise unchanged.
export function formatCiBracket(ci: WorkerInfo["ci"]): string {
  if (!ci) return "";
  if (ci.fixing) {
    const attempts = ci.attempts ?? 1;
    const budget = ci.budget ?? CI_FIX_BUDGET_DISPLAY;
    return ` [CI fix ${attempts}/${budget}]`;
  }
  if (ci.failing) {
    const sha = ci.failingSha ? ` ${ci.failingSha.slice(0, 7)}` : "";
    return ` [CI ✗${sha}]`;
  }
  return "";
}

// Format the trellis bracket for a vine row. Layout per WORKFLOWS.md
// "Worker row":
//   Active vine, drifting:   [trellis: auth-rewrite | 4/30 | 3 drift]
//   Aligned terminal:        [trellis: auth-rewrite | ✓ aligned, 7 iters]
//   Flagged:                 [trellis: auth-rewrite | flagged]
//   Budget exhausted:        [trellis: auth-rewrite | budget exhausted]
//   Stagnated (v1.5):        [trellis: auth-rewrite | stagnated]
// Iteration counter color: white normally, yellow at ≥80% of cap,
// red at ≥95%. The bracket is returned without a leading separator; the
// row renderer (formatRowTail) places it in the activity slot so its "["
// aligns with the activity column of sibling rows.
export function formatTrellisBracket(t: WorkerInfo["trellis"]): string {
  if (!t) return "";
  // Failed states: prefer the failure reason over the iteration counter.
  if (t.failingReason === "trellis-flagged") {
    return `[trellis: ${t.name} | flagged]`;
  }
  if (t.failingReason === "iteration-budget") {
    return `[trellis: ${t.name} | budget exhausted]`;
  }
  if (t.failingReason === "stagnation") {
    return `[trellis: ${t.name} | stagnated]`;
  }
  // Aligned terminal: distinguish reviewer-declared success from operator
  // sentinel-set with a check decoration + iteration count.
  if (t.aligned) {
    const noun = t.iteration === 1 ? "iter" : "iters";
    return `[trellis: ${t.name} | ✓ aligned, ${t.iteration} ${noun}]`;
  }
  // Active loop. Iteration counter with color thresholds.
  const iterStr = colorizeIteration(t.iteration, t.maxIterations);
  const driftSeg = t.driftCount > 0 ? ` | ${t.driftCount} drift` : "";
  return `[trellis: ${t.name} | ${iterStr}${driftSeg}]`;
}

// Compose the row segment that trails the status column. Trellis vines show
// only their bracket — placed in the activity slot (two spaces after the
// status, matching the activity column) so its "[" lines up with the
// description text on sibling rows — and drop the live activity, which
// restates the trellis name. A branch hint still trails the bracket when the
// worker's pinned base diverges from the checkout (a real warning, not
// redundant). Default/grow rows keep the CI bracket + activity.
function formatRowTail(worker: WorkerInfo, baseHint: string, activityMax?: number): string {
  const trellis = formatTrellisBracket(worker.trellis);
  if (trellis) return `  ${trellis}${baseHint}`;
  const ciBracket = formatCiBracket(worker.ci);
  const text = worker.activity
    ? `  ${activityMax !== undefined ? truncateActivity(worker.activity, activityMax) : worker.activity}`
    : "";
  return `${ciBracket}${text}${baseHint}`;
}

// Look up the project's currently checked-out branch. Returns null if the
// project isn't registered, the path is missing, or git couldn't be reached.
// Used only to compare against each worker's pinned baseBranch so the
// renderer can flag the divergence — the operator already sees the current
// branch on the bottom status bar via formatLeft (header.ts), so we don't
// repeat it on the worker list itself.
//
// Per-process TTL cache for this DISPLAY-only value. refreshDashboard re-bakes
// the status on every state transition, and in the long-lived poller and
// dashboard processes a burst of transitions (many agents flipping state under
// load) would otherwise fork `git rev-parse` once per project per bake. The
// checkout's branch *name* changes only on an operator `git checkout` — a
// post-merge fast-forward advances the ref, not the name — so a few seconds of
// staleness on this string is invisible. Merge/base decisions must NOT use
// this; they call currentBranch directly (git.ts resolveBaseBranch and the
// off-base fast-forward guard) so they always see ground truth.
const PROJECT_BRANCH_TTL_MS = 5_000;
const projectBranchCache = new Map<string, { branch: string | null; at: number }>();

/** Test-only: clear the project-branch TTL cache between cases. */
export function _resetStatusBranchCacheForTest(): void {
  projectBranchCache.clear();
}

function resolveProjectBranch(
  projectName: string,
  config?: ReturnType<typeof loadConfig>,
): string | null {
  const cached = projectBranchCache.get(projectName);
  const now = Date.now();
  if (cached && now - cached.at < PROJECT_BRANCH_TTL_MS) return cached.branch;
  // Take the repo path from the already-loaded config on the hot render path;
  // tryGetProject re-parses config.yml, which the per-project render loop would
  // otherwise pay N times per bake. Fall back to tryGetProject for the CLI path
  // (once per `garden status`, no threaded config).
  const repoPath = config ? config.projects[projectName]?.path : tryGetProject(projectName)?.path;
  if (!repoPath) return null;
  const branch = currentBranchFast(repoPath);
  projectBranchCache.set(projectName, { branch, at: now });
  return branch;
}

// Branch hint appended to a worker row. The yellow "→ <base>" flags a worker
// whose pinned base diverges from the project's current checkout — the leading
// indicator of the "did not fast-forward after merge" alert pattern (the
// operator switched checkouts after creating the worker, and the worker still
// merges to its pinned base). Showing it in yellow makes the divergence obvious
// without requiring a registry inspection.
//
// When ANY worker in the project diverges (showMatching), the workers whose
// base *matches* the checkout also render their base — in grey, not yellow — so
// the operator sees, per row, what each worker targets. Without this, a mixed
// project would show "→ feature" on one row and nothing on the others, leaving
// it ambiguous whether the silent rows target the checkout or just aren't
// flagged. Grey keeps the yellow reserved for the actual divergence warning.
function formatBranchHint(
  workerBase: string | undefined,
  projectBranch: string | null | undefined,
  showMatching: boolean,
): string {
  if (!workerBase || !projectBranch) return "";
  if (workerBase !== projectBranch) return ` \x1b[33m→ ${workerBase}\x1b[0m`;
  if (showMatching) return ` \x1b[90m→ ${workerBase}\x1b[0m`;
  return "";
}

// True when at least one worker's pinned base diverges from the project's
// current checkout. Drives formatBranchHint's showMatching: a project with any
// off-base worker renders every row's target so the picture is unambiguous.
// Legacy workers without a pinned baseBranch never count as divergent.
function projectHasBranchDivergence(
  workers: WorkerInfo[],
  projectBranch: string | null | undefined,
): boolean {
  if (!projectBranch) return false;
  return workers.some(w => w.baseBranch !== undefined && w.baseBranch !== projectBranch);
}

// Dimmed pencil appended to a project's header row when its diary holds
// non-whitespace content — answers "did I leave notes here?", which nothing
// else on the row shows. Intentionally quiet (grey) so it reads as metadata,
// not as a worker-status glyph; placed before the active-project marker.
function formatDiaryGlyph(projectName: string): string {
  return diaryHasContent(projectName) ? " \x1b[90m✎\x1b[0m" : "";
}

// Quiet grey crew badge on a project's header row — which harness/provider
// pair builds and reviews this project's fleet. Same metadata-not-status
// styling as the diary glyph. "custom" when the roles are hand-tuned past a
// named crew. Read from the already-loaded config, so no extra IO per bake.
function formatCrewBadge(project: ProjectConfig, config: GardenConfig): string {
  const crew = deriveCrew(project, config) ?? "custom";
  return ` \x1b[90m${crew}\x1b[0m`;
}

function colorizeIteration(iter: number, max: number): string {
  const ratio = max > 0 ? iter / max : 0;
  const text = `${iter}/${max}`;
  if (ratio >= 0.95) return `\x1b[31m${text}\x1b[0m`;   // red
  if (ratio >= 0.80) return `\x1b[33m${text}\x1b[0m`;   // yellow
  return text;                                          // default
}

// States that carry a dim elapsed-time-in-state suffix ("reviewing 12m",
// "merging 47m", "asking 2h"). These are the pipeline and blocked states — the
// "autonomous middle" where a row is otherwise log-shaped and the operator
// can't tell a progressing worker from a wedged one. `working` is excluded (its
// spinner already signals liveness); terminal `merged`/`done` are excluded
// (their decoration belongs to the auto-continue gate surface, not here).
const TIME_IN_STATE_STATES = new Set<WorkerStatus>([
  "reviewing", "merge-pending", "resolving", "ci-fixing", "asking", "failing",
]);

// Soft per-state expectations: once elapsed passes this, the suffix turns yellow
// to flag "taking unusually long." Only the otherwise-uncolored pipeline states
// escalate — `asking`/`failing` rows are already whole-row colored (bold-yellow
// / bold-red via colorizeRow), so their elapsed stays dim rather than fight the
// row color. All thresholds sit well under the hard REVIEW_TIMEOUT_MS (60m)
// kill so "slow" reads long before "killed."
const TIME_IN_STATE_SOFT_MS: Partial<Record<WorkerStatus, number>> = {
  reviewing: 10 * 60_000,
  "merge-pending": 10 * 60_000,
  resolving: 10 * 60_000,
  "ci-fixing": 15 * 60_000,
};

// Below this the suffix is suppressed: a freshly entered state doesn't need a
// "0m", and the value would be noise between the entry-triggered bake and the
// watchdog's first 60s re-bake.
const TIME_IN_STATE_FLOOR_MS = 60_000;

function humanizeElapsed(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// Dim elapsed-time-in-state suffix for a worker row, or "" when the state isn't
// time-tracked, the timestamp is missing, or the state was entered under a
// minute ago. Grey by default, yellow past the state's soft expectation.
// Rendered as a self-contained color span (ends in a reset) and placed LAST on
// the row so it stays ANSI-clean inside colorizeRow/dimRow wrapping and is the
// first thing dropped if the row is width-capped.
export function formatTimeInState(
  status: WorkerStatus,
  lastStateChangeAt: number | undefined,
  now: number,
): string {
  if (lastStateChangeAt === undefined || !TIME_IN_STATE_STATES.has(status)) return "";
  const elapsed = now - lastStateChangeAt;
  if (elapsed < TIME_IN_STATE_FLOOR_MS) return "";
  const soft = TIME_IN_STATE_SOFT_MS[status];
  const color = soft !== undefined && elapsed >= soft ? "33" : "90"; // yellow : grey
  return ` \x1b[${color}m${humanizeElapsed(elapsed)}\x1b[0m`;
}

// Suffix on a `merged` row when the global auto-continue gate is closed. A
// merged worker would normally auto-continue into its next phase; a closed gate
// (operator `garden auto off`, or a usage-threshold pause) holds it parked
// instead — the "why is this merged worker just sitting here" the row otherwise
// can't answer. Yellow because it's operator-actionable (`garden auto on`).
// Only `merged` strands on the gate: `done` opted out via its own sentinel, and
// active states aren't waiting on it. Placed last on the row like the
// time-in-state suffix so it stays ANSI-clean and truncates first.
export function formatGateSuffix(status: WorkerStatus, gateClosed: boolean): string {
  if (status !== "merged" || !gateClosed) return "";
  return " \x1b[33mgate closed\x1b[0m";
}

function collectWorkers(
  projectName: string,
  state: DashboardState,
  windowNames?: string[],
  cachedRegistry?: WorkerRegistry,
): WorkerInfo[] {
  const workers: WorkerInfo[] = [];
  // When a cache is provided, missing project key means "no workers" — don't
  // fall back to getWorkers(): that re-reads the registry and defeats the
  // cache for every plot project without a worker entry.
  const registryEntries = cachedRegistry
    ? (cachedRegistry.workers[projectName] ?? [])
    : getWorkers(projectName);
  const registryByName = new Map(registryEntries.map(e => [e.name, e]));

  if (state.activeProject === projectName && state.activePaneType === "worker") {
    const label = parseWorkerSuffix(state.activeWindowName ?? "") ?? "worker-1";
    const entry = registryByName.get(label);
    workers.push({
      name: label,
      status: resolveWorkerStatus(entry),
      activity: entry?.task || null,
      active: true,
      lastStateChangeAt: entry?.lastStateChangeAt,
      stale: entry ? isWorkerStale(entry) : false,
      failCount: entry?.failCount ?? 0,
      baseBranch: entry?.baseBranch,
      trellis: trellisInfoFor(entry),
      ci: ciInfoFor(entry),
    });
  }

  const hiddenWindows = listHiddenWorkerWindows(projectName, windowNames);
  for (const win of hiddenWindows) {
    if (win === state.activeWindowName) continue;
    const label = parseWorkerSuffix(win) ?? win;
    const entry = registryByName.get(label);
    workers.push({
      name: label,
      status: resolveWorkerStatus(entry),
      activity: entry?.task || null,
      active: false,
      lastStateChangeAt: entry?.lastStateChangeAt,
      stale: entry ? isWorkerStale(entry) : false,
      failCount: entry?.failCount ?? 0,
      baseBranch: entry?.baseBranch,
      trellis: trellisInfoFor(entry),
      ci: ciInfoFor(entry),
    });
  }

  // Order by attention/recency, not name (the name is just an address handle).
  // Compares the underlying registry entries; orphan windows with no entry sort
  // last by name. See compareWorkerFreshness in registry.ts.
  workers.sort((a, b) => {
    const ea = registryByName.get(a.name);
    const eb = registryByName.get(b.name);
    if (ea && eb) return compareWorkerFreshness(ea, eb);
    if (ea) return -1;
    if (eb) return 1;
    return a.name.localeCompare(b.name);
  });
  return workers;
}

/**
 * Render status from state + registry. Used by writeQuickStatus() to bake
 * the status pane content to a file before SIGUSR1, and reused by `garden
 * status` directly. There is one render path.
 */
export function renderQuickStatus(
  state: DashboardState,
  windowNames?: string[],
  cachedConfig?: ReturnType<typeof loadConfig>,
  cachedRegistry?: WorkerRegistry,
  paneWidth?: number,
): string {
  const config = cachedConfig ?? loadConfig();
  const names = getFocusedProjectNames(config, state.activePlot);
  if (names.length === 0) return "No projects added.";

  const lines: string[] = [];
  const allWorkers: WorkerInfo[] = [];

  const projectWorkers: WorkerInfo[][] = names.map((name) => {
    const workers = collectWorkers(name, state, windowNames, cachedRegistry);
    allWorkers.push(...workers);
    return workers;
  });

  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = STATUS_WIDTH;

  const projectBranches = names.map(n => resolveProjectBranch(n, config));

  // One clock read per bake so every row's elapsed suffix is consistent.
  const now = Date.now();
  // Global auto-continue gate — read once (from the already-loaded config, no
  // extra IO) so `merged` rows can flag when the gate is holding them parked.
  const gateClosed = !getAutoContinueConfig(config).enabled;

  lines.push("");
  for (let pi = 0; pi < names.length; pi++) {
    if (pi > 0) lines.push("");
    const name = names[pi];
    const isActive = state.activeProject === name;
    const marker = isActive ? " \u25C4" : "";
    const displayName = isActive ? `\x1b[1;32m${name}\x1b[0m` : name;
    const projectBranch = projectBranches[pi];
    const crewBadge = config.projects[name] ? formatCrewBadge(config.projects[name], config) : "";
    lines.push(`  ${pi + 1}. ${displayName}${crewBadge}${formatDiaryGlyph(name)}${marker}`);

    const workers = projectWorkers[pi];
    if (workers.length === 0) {
      lines.push("    (no workers)");
    } else {
      const showAllBranches = projectHasBranchDivergence(workers, projectBranch);
      for (const worker of workers) {
        const focus = worker.active ? "\u25CF" : "\u25CB";
        const icon = iconFor(worker);
        const wname = worker.name.padEnd(nameWidth);
        const wstatus = formatStatus(worker).padEnd(statusWidth);
        const baseHint = formatBranchHint(worker.baseBranch, projectBranch, showAllBranches);
        const elapsed = formatTimeInState(worker.status, worker.lastStateChangeAt, now);
        const gate = formatGateSuffix(worker.status, gateClosed);
        const line = `    ${focus} ${icon} ${wname}  ${wstatus}${formatRowTail(worker, baseHint)}${elapsed}${gate}`;
        const colored = colorizeRow(worker.status, line);
        lines.push(worker.stale ? dimRow(colored) : colored);
      }
    }
  }
  lines.push("");

  // Hard-cap each line to the pane width (with a 2-column margin for terminals
  // that render the ambiguous-width focus/icon glyphs double-wide) so no row
  // wraps, then append clear-to-end-of-line so the status pane can overwrite in
  // place without full screen clears (avoids flashing). Without paneWidth (the
  // height-only callers in create.ts) rows are left uncapped — the line COUNT
  // is identical either way, so their height math is unaffected.
  const cap = paneWidth && paneWidth > 0 ? Math.max(1, paneWidth - 2) : undefined;
  return lines
    .map(l => (cap !== undefined ? truncateToVisibleWidth(l, cap) : l) + "\x1b[K")
    .join("\n");
}
