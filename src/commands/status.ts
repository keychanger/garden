// Shows project status: registered projects, active workers, and their states.
//
// Per STATUS.md, the registry is the single source of truth and there is one
// render path. This file reads agentStatus and prState from the registry,
// combines them via resolveWorkerStatus(), and renders. It does not call
// pgrep and does not read marker files. Before rendering, it refreshes
// worker task summaries from live tmux pane titles so the registry stays
// current between hook events.
import { loadConfig, getFocusedProjectNames, allPlotProjectNames, tryGetProject, getAutoContinueConfig, projectUsageGateExempt, type AutoContinueConfig } from "../config.js";
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { output, isTTY } from "../output.js";
import { readDashState, type DashboardState } from "../dashboard/state.js";
import { getWorkers, readRegistry, batchUpdateWorkerFields, compareWorkerFreshness, isWorkerStale, type WorkerRegistry } from "../dashboard/registry.js";
import { listHiddenWorkerWindows, windowExists, getFirstPaneId, getPaneTitle } from "../dashboard/tmux.js";
import { resolveWorkerActivity } from "../dashboard/harness/core.js";
import { workerWindowName as workerWin, parseWorkerSuffix } from "../dashboard/window-names.js";
import { currentBranchFast, branchExistsOnOrigin } from "../dashboard/git.js";
import { diaryHasContent } from "../diary.js";
import { isAwaitingInput } from "../dashboard/continue.js";
import { deriveCrew, workerMemberName, projectWorkerMemberName } from "../dashboard/crew.js";
import { unreadAlertCountsByProject } from "../dashboard/alerts.js";
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
  // True when the worker holds the `.garden-awaiting-input` sentinel — a
  // botanist (or future plan worker) paused at the human gate, waiting on the
  // operator. Distinct from the mid-turn `asking` state (a first-class status):
  // the worker is still in poller state `working`, it just wrote the sentinel
  // and ended its turn. Renders a `?` in the row flags.
  awaitingInput: boolean;
  failCount: number;
  // The branch this worker is pinned to merge into. Undefined for legacy
  // entries written before the field existed. The renderer compares it
  // against the project's current checkout and appends "→ <base>" when
  // they diverge — that mismatch is the leading indicator of the
  // "did not fast-forward after merge" alert pattern.
  baseBranch?: string;
  // Identity fields, rendered grey and override-only. The worker's harness (a
  // member badge shows when it differs from the project's default member) and
  // the workflow (drives workflowRowDecor) join the badge cluster, and the
  // pinned model (default/grow use entry.model, vines use trellis.workerModel)
  // is the cluster's trailing tag — the whole cluster trails the detail column
  // (see renderWorkerRow), so a badge costs width only on the row carrying it.
  // All undefined for a plain default-workflow worker on the account default,
  // in which case nothing renders — default is invisible.
  harness?: string;
  // Per-worker provider backend (entry.provider). Pairs with `harness` to name
  // the worker's build member — a worker on a different backend than its
  // project badges that member, so a `deepseek` builder on a first-party
  // project reads as one.
  provider?: string;
  model?: string;
  workflow?: string;
  // Per-worker crew override (entry.crew). When set and differing from the
  // project's default crew, the row shows a grey crew badge (which encodes the
  // reviewer) IN PLACE OF the build-member badge — so a worker with a
  // non-default reviewer is visible at a glance, not just in the ⌥i menu.
  crew?: string;
  // Grow loop counter for the workflow-row decoration (grow N/M), the parity
  // fix for trellis's iteration bracket. Undefined for non-grow workers.
  grow?: { iteration: number; maxIterations: number };
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
  // True while the worker sits in `reviewing` for its interposed whole-task
  // final review (entry.holisticFinalActive) — NOT a per-phase review. The
  // renderer tags the row so the operator sees the final coherence pass is in
  // flight before the worker truly finishes.
  holisticFinal?: boolean;
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

// The per-render context a worker row needs beyond the worker itself. Both
// render paths build one of these per project. `detailMax` (TTY) and `cap`
// (baked) bound the row width; `projectMember`/`projectProvider` are the
// baseline the per-worker member badge is compared against (both computed once
// per project).
interface RowRenderCtx {
  now: number;
  gateClosed: boolean;
  projectBranch: string | null | undefined;
  showAllBranches: boolean;
  // Phase 2 — explicit baseBranch. When the project has a configured base,
  // the row uses the per-worker override semantics (grey = deliberate
  // override, yellow = base missing from origin) and ignores showAllBranches;
  // missingBases holds the worker bases that no longer exist on origin.
  // Undefined configuredBase keeps the legacy checkout-divergence path
  // (formatBranchHint + showAllBranches) byte-identical.
  configuredBase?: string;
  missingBases?: ReadonlySet<string>;
  // Phase 3 — the member the project's default worker resolves to (harness +
  // provider). A worker whose member differs gets a grey badge.
  projectMember: string;
  projectProvider?: string;
  // The project's default crew — the baseline a per-worker crew override
  // (entry.crew) is compared against for the row's crew badge.
  projectCrew: string;
}

// The pieces of a worker row, assembled by collectSegments and laid out by
// renderWorkerRow. Splitting collection from layout is what lets the TTY and
// baked paths share one row definition. The grammar (DESIGN.md "Worker row
// grammar"),
// left to right: core (focus/icon/name/state), then the elastic detail
// (description) — nothing sits between the state and the description — then the
// grey identity cluster (badges + model) trailing, then the status-class flags.
// core and flags never drop; the identity cluster is override-only and drops as
// a unit before detail is lost; detail is the elastic column that truncates first.
interface RowSegments {
  focus: string;
  icon: string;
  name: string;    // unpadded; renderWorkerRow pads to the column width
  state: string;   // formatStatus + the elapsed-in-state suffix, folded in
  badges: string[]; // grey identity (base, crew, member, workflow), trailing after detail
  detail: string;  // activity or the workflow bracket — the elastic column, first after state
  model: string;   // grey model badge, trails with the badge cluster ("" when unpinned)
  flags: string;   // status-class end-of-row (gate, CI bracket)
  status: WorkerStatus;
  stale: boolean;
}

// A grey (metadata) identity badge. Base badges are pre-styled by the branch-
// hint helpers (grey or yellow); member/model wear this uniform grey.
function greyBadge(text: string): string {
  return `\x1b[90m${text}\x1b[0m`;
}

// Below this many columns of detail budget, drop the badge cluster as a unit so
// the detail (what the worker is doing) isn't squeezed to nothing on a narrow
// pane — the "badges drop before detail is lost" half of the truncation rule.
const DETAIL_MIN_WIDTH = 12;

// Build the row segments for one worker. Pure over (worker, ctx) — no I/O — so
// both paths call it and stay identical by construction.
function collectSegments(worker: WorkerInfo, ctx: RowRenderCtx): RowSegments {
  const baseBadge = ctx.configuredBase !== undefined
    ? formatConfiguredBaseHint(worker.baseBranch, ctx.configuredBase, ctx.missingBases)
    : formatBranchHint(worker.baseBranch, ctx.projectBranch, ctx.showAllBranches);
  // A per-worker crew override shows the crew name (it encodes both build +
  // reviewer) and SUPERSEDES the build-member badge, since --crew sets
  // entry.harness consistently with the crew's worker member — so the member
  // badge would be redundant. A bare --harness override (no crew) still shows
  // the member badge.
  const crewBadge = (worker.crew && worker.crew !== ctx.projectCrew) ? greyBadge(worker.crew) : "";
  // The worker's OWN backend when it carries one, else the project's — so the
  // badge names the member this worker actually is, not the one its project
  // defaults to.
  const workerMember = workerMemberName(worker.harness, worker.provider ?? ctx.projectProvider);
  const memberBadge = (!crewBadge && workerMember !== ctx.projectMember) ? greyBadge(workerMember) : "";
  const decor = workflowRowDecor(worker);
  const workflowBadge = decor.badge ? greyBadge(decor.badge) : "";
  const badges = [baseBadge, crewBadge, memberBadge, workflowBadge].filter(b => b !== "");
  // The interposed whole-task final review reuses the `reviewing` state; tag it
  // in the detail column so it reads as the final coherence pass, not a normal
  // per-phase review. Takes the elastic slot ahead of the workflow decor/activity.
  const holisticDetail = worker.holisticFinal && worker.status === "reviewing"
    ? "holistic review"
    : undefined;
  return {
    focus: worker.active ? "●" : "○",
    icon: iconFor(worker),
    name: worker.name,
    state: stateCell(worker, ctx.now),
    badges,
    detail: holisticDetail ?? decor.detail ?? (worker.activity ?? ""),
    // The pinned model is grey identity like the badges above; renderWorkerRow
    // trails the whole cluster after the detail (see there for why).
    model: worker.model ? greyBadge(worker.model) : "",
    flags: `${formatAwaitingInputGlyph(worker)}${formatGateSuffix(worker.status, ctx.gateClosed)}${formatCiBracket(worker.ci)}`,
    status: worker.status,
    stale: worker.stale,
  };
}

// Lay out a worker row from its segments. The single place row column order,
// truncation priority, coloring, and staleness dimming are decided — shared by
// both render paths. `cap` (baked) enforces the truncation grammar; `detailMax`
// (TTY) is a soft detail bound.
function renderWorkerRow(
  seg: RowSegments,
  dims: { nameWidth: number; stateWidth: number; cap?: number; detailMax?: number },
): string {
  const core = `    ${seg.focus} ${seg.icon} ${padEndVisible(seg.name, dims.nameWidth)}  ${padEndVisible(seg.state, dims.stateWidth)}`;
  // The whole grey identity cluster — base/crew/member/workflow badges plus the
  // pinned model — trails the detail column so nothing sits between the state
  // and the description: the description is the row's primary content and must
  // read first (operator call, 2026-07-16). Ragged-right, not a shared padded
  // column, so it costs width only on the rows that carry it rather than pushing
  // every plain row's description to the right; it drops as a unit when the pane
  // is too narrow to keep the detail readable.
  const identity = [...seg.badges, seg.model].filter(t => t !== "");
  let identityCell = identity.length > 0 ? `  ${identity.join("  ")}` : "";
  let detail = seg.detail;

  // Detail budget: baked (cap) derives it so core + flags never drop and the
  // trailing identity cluster drops as a unit before detail is lost; TTY uses
  // detailMax as a soft bound.
  let budget = dims.detailMax;
  if (dims.cap !== undefined) {
    const fixed = visibleWidth(core) + visibleWidth(seg.flags);
    const identityWidth = visibleWidth(identityCell);
    budget = dims.cap - fixed - identityWidth - (detail ? 2 : 0);
    if (budget < DETAIL_MIN_WIDTH && identityWidth > 0) {
      identityCell = "";
      budget = dims.cap - fixed - (detail ? 2 : 0);
    }
  }
  if (budget !== undefined && detail && visibleWidth(detail) > budget) {
    detail = truncateToVisibleWidth(detail, Math.max(0, budget));
  }

  const detailCell = detail ? `  ${detail}` : "";
  const line = `${core}${detailCell}${identityCell}${seg.flags}`;
  const colored = colorizeRow(seg.status, line);
  return seg.stale ? dimRow(colored) : colored;
}

// Render a project header row. Shared by both paths. Layout (DESIGN.md "Worker
// row grammar"): `<n>. <name> <⋅base> <crew> ✎ ⚠n ◄` — grey identity tokens, then
// the yellow unread-alert count, then the active marker.
function renderProjectHeader(h: {
  index: number;
  name: string;
  isActive: boolean;
  projectConfig: ProjectConfig | undefined;
  config: GardenConfig;
  alertCount: number;
}): string {
  const marker = h.isActive ? " ◄" : "";
  const displayName = h.isActive ? `\x1b[1;32m${h.name}\x1b[0m` : h.name;
  const baseToken = formatConfiguredBaseToken(h.projectConfig);
  // Crew badge only on the FOCUSED project's header — it's context for the
  // project you're working in, not standing grey across the whole list
  // (operator call, 2026-07-16). Shown for every crew, including the default
  // all-claude, so the focused project's crew is always visible.
  const crewBadge = (h.isActive && h.projectConfig) ? formatCrewBadge(h.projectConfig, h.config) : "";
  const alert = h.alertCount > 0 ? ` \x1b[33m⚠${h.alertCount}\x1b[0m` : "";
  return `  ${h.index}. ${displayName}${baseToken}${crewBadge}${formatDiaryGlyph(h.name)}${alert}${marker}`;
}

// Refresh all workers' task fields from whatever source their harness owns
// (resolveWorkerActivity — the live pane title for Claude Code, the transcript
// for Codex). Called before rendering so the registry has current data even if
// no hook has fired recently (e.g. workers in the middle of a long work
// session). This keeps the registry as the source of truth — we update it,
// then render from it.
function refreshWorkerTasks(state: DashboardState): void {
  try {
    const registry = readRegistry();
    const updates: Array<{ project: string; workerName: string; fields: { task: string } }> = [];

    for (const [project, entries] of Object.entries(registry.workers)) {
      for (const entry of entries) {
        const summary = resolveWorkerActivity(entry, () => {
          const windowName = workerWin(project, entry.name);
          let paneId: string | null = null;
          if (state.activeWindowName === windowName && state.activePaneId) {
            paneId = state.activePaneId;
          } else if (windowExists(windowName)) {
            paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
          }
          return paneId ? getPaneTitle(paneId) : null;
        });
        if (summary && summary !== entry.task) {
          updates.push({ project, workerName: entry.name, fields: { task: summary } });
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

  // One clock read per render so every row's elapsed suffix — and the state
  // column width derived from it — is consistent, and one alert-store read so
  // every header's ⚠n count is consistent.
  const now = Date.now();
  const allWorkers = statuses.flatMap(p => p.workers);
  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = computeStatusWidth(allWorkers, now);
  const cols = process.stdout.columns || 120;
  const detailMax = Math.max(20, cols - (8 + nameWidth + 2 + statusWidth + 2));

  const acConfig = getAutoContinueConfig(config);
  const alertCounts = unreadAlertCountsByProject();

  console.log("");
  for (let pi = 0; pi < statuses.length; pi++) {
    if (pi > 0) console.log("");
    const project = statuses[pi];
    const projectConfig = config.projects[project.name];
    const gateClosed = gateHoldsProject(acConfig, project.name, config);
    console.log(renderProjectHeader({
      index: project.index,
      name: project.name,
      isActive: project.isActive,
      projectConfig,
      config,
      alertCount: alertCounts.get(project.name) ?? 0,
    }));

    if (project.workers.length === 0) {
      console.log("    (no workers)");
    } else {
      const configuredBase = projectConfig?.baseBranch;
      const ctx: RowRenderCtx = {
        now,
        gateClosed,
        projectBranch: project.projectBranch,
        showAllBranches: configuredBase === undefined
          ? projectHasBranchDivergence(project.workers, project.projectBranch)
          : false,
        configuredBase,
        missingBases: configuredBase === undefined
          ? undefined
          : collectMissingBases(project.name, projectConfig?.path, definedBases(project.workers)),
        projectMember: projectConfig ? projectWorkerMemberName(projectConfig, config) : "claude",
        projectProvider: projectConfig?.provider,
        projectCrew: projectConfig ? (deriveCrew(projectConfig, config) ?? "custom") : "custom",
      };
      const segments = project.workers.map(w => collectSegments(w, ctx));
      for (const seg of segments) {
        console.log(renderWorkerRow(seg, { nameWidth, stateWidth: statusWidth, detailMax }));
      }
    }
  }
  console.log("");
}

// Floor for the state column so an empty (or all-tiny) fleet still has a sane
// width — "done"/"idle" is 4. The column otherwise sizes to the widest state
// cell actually on screen (see computeStatusWidth), rather than reserving the
// 13 columns only the longest transient state ("reviewing 12m") ever needs.
const STATUS_MIN_WIDTH = 4;

function formatStatus(worker: WorkerInfo): string {
  if (worker.status === "merge-pending") return "merging";
  return worker.status;
}

// The state cell: the state word plus the folded-in dim elapsed-in-state suffix
// (e.g. "reviewing 12m"). Shared by collectSegments (which renders it) and
// computeStatusWidth (which measures it) so the measured width and the rendered
// text can never drift.
function stateCell(worker: WorkerInfo, now: number): string {
  return `${formatStatus(worker)}${formatTimeInState(worker.status, worker.lastStateChangeAt, now)}`;
}

// Width of the state column: the widest state cell across ALL workers on screen,
// floored. Sized like the name column (max over the workers actually shown, not
// a worst-case constant) so a fleet of short `done`/`idle` rows doesn't reserve
// the 13 columns only "reviewing 12m" needs — that reserved-but-unused width was
// the dead space between the state and the description. Global (every project's
// workers) so the detail column stays aligned across projects, matching how
// nameWidth is computed. ANSI-aware via visibleWidth (the elapsed suffix is
// colored). Recomputed each bake, so as the sole long state clears the column
// tightens on the next refresh (the watchdog's 60s re-bake, or any transition).
function computeStatusWidth(workers: WorkerInfo[], now: number): number {
  let max = STATUS_MIN_WIDTH;
  for (const w of workers) {
    const width = visibleWidth(stateCell(w, now));
    if (width > max) max = width;
  }
  return max;
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
// A single CSI escape sequence anchored at the string start — shared by the two
// ANSI-aware width scanners below (status rows carry only CSI color codes).
const CSI_SEQ = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

export function truncateToVisibleWidth(s: string, maxWidth: number): string {
  let out = "";
  let visible = 0;
  let sawEscape = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = CSI_SEQ.exec(s.slice(i));
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

// Visible column width of a string, ignoring CSI escape sequences (they render
// zero-width). The width-aware analog of `String.length` for padding rows that
// carry ANSI — `String.padEnd` counts escape bytes and over-pads, so once a
// column holds colored content (the elapsed suffix, the identity badges) plain
// padEnd misaligns every following column.
export function visibleWidth(s: string): number {
  let width = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = CSI_SEQ.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i)!;
    width += codePointWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

// Right-pad `s` with spaces to `width` visible columns (no-op if already at
// least that wide). ANSI-aware via visibleWidth so a colored cell lands in a
// fixed column.
function padEndVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
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

// Distill the grow loop counter off a registry entry. Returns undefined for
// non-grow workers — the parity counterpart of trellisInfoFor.
function growInfoFor(entry?: { workflow?: string; grow?: { iteration?: number; maxIterations?: number } }): WorkerInfo["grow"] {
  if (!entry || entry.workflow !== "grow") return undefined;
  return {
    iteration: entry.grow?.iteration ?? 0,
    maxIterations: entry.grow?.maxIterations ?? 0,
  };
}

// Format the CI bracket for a default-workflow row when the worker is in
// `ci-fixing` (auto-fix in flight) or `failing` with reason `ci` (auto-fix
// exhausted). Trellis vines route through formatTrellisBracket above and
// don't reach here. The bracket is a status-class flag: collectSegments folds
// it into `seg.flags`, placed at the end of the row after the detail column
// and never truncated. Its single leading space separates it from the
// preceding column.
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
// red at ≥95%. The bracket is returned without a leading separator;
// workflowRowDecor places it in the detail column (the elastic slot) so its
// "[" aligns with the detail column of sibling rows.
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

// Per-workflow row decoration, keyed on entry.workflow — the leaf-function form
// of the WorkflowDefinition.renderRow primitive named in WORKFLOWS.md "Worker
// row". It reads only WorkerInfo data and MUST NOT reach into
// src/dashboard/workflows/: a `getWorkflow(...).renderRow` call would drag the
// full poller graph into status.ts's import closure (used by `garden status`,
// plot-status.ts, and the dist/hook.js bundle) — the exact boundary
// CI_FIX_BUDGET_DISPLAY is inlined to preserve. `detail` fills the elastic
// detail column; a vine shows its bracket, a grow loop its "grow N/M" counter
// (the parity fix — trellis had a counter, grow had nothing). `badge` joins
// the grey trailing identity cluster — the botanist tag lives there.
function workflowRowDecor(worker: WorkerInfo): { badge?: string; detail?: string } {
  switch (worker.workflow) {
    case "trellis":
      return { detail: formatTrellisBracket(worker.trellis) };
    case "grow":
      return { detail: `grow ${worker.grow?.iteration ?? 0}/${worker.grow?.maxIterations ?? 0}` };
    case "botanist":
      // Identity, not activity: the badge joins the grey trailing cluster so
      // the live activity text keeps the detail slot (a static detail here
      // would clobber it).
      return { badge: "botanist" };
    default:
      return {};
  }
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

// Per-project TTL cache of the worker bases missing from origin, for projects
// with an explicit baseBranch. branchExistsOnOrigin forks `git show-ref`, and
// the status pane re-bakes on every state transition, so — like
// projectBranchCache — this bounds the git cost to one batch per project per
// TTL. Only configured projects populate it; unset projects never call in.
const missingBaseCache = new Map<string, { missing: ReadonlySet<string>; at: number }>();

/** Test-only: clear the status-pane TTL caches between cases. */
export function _resetStatusBranchCacheForTest(): void {
  projectBranchCache.clear();
  missingBaseCache.clear();
}

// The subset of `workerBases` that no longer exists on origin for a configured
// project — a merge into a vanished base will fail, so the row flags it yellow.
// TTL-cached per project (see missingBaseCache); empty when repoPath is unknown.
function collectMissingBases(
  projectName: string,
  repoPath: string | undefined,
  workerBases: Iterable<string>,
): ReadonlySet<string> {
  const cached = missingBaseCache.get(projectName);
  const now = Date.now();
  if (cached && now - cached.at < PROJECT_BRANCH_TTL_MS) return cached.missing;
  const missing = new Set<string>();
  if (repoPath) {
    for (const base of new Set(workerBases)) {
      if (!branchExistsOnOrigin(repoPath, base)) missing.add(base);
    }
  }
  missingBaseCache.set(projectName, { missing, at: now });
  return missing;
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

// Branch hint appended to a worker row: a grey "→ <base>" naming the base a
// worker merges into when it differs from the project's current checkout. This
// is informational, not a warning — merging into a non-checked-out base is a
// fully supported workflow (the post-merge step advances that base's ref on its
// own), so it wears the same quiet grey as the row's other identity badges
// rather than a yellow alert color (operator call, 2026-07-16). The one genuine
// fault — a base gone from origin, where the merge WILL fail — is yellow, but
// only the configured-base path (formatConfiguredBaseHint) can detect it.
//
// When ANY worker in the project diverges (showMatching), the workers whose
// base *matches* the checkout render their base too, so the operator sees per
// row what each worker targets. Without this, a mixed project would show
// "→ feature" on one row and nothing on the others, leaving it ambiguous whether
// the silent rows target the checkout or just aren't flagged.
function formatBranchHint(
  workerBase: string | undefined,
  projectBranch: string | null | undefined,
  showMatching: boolean,
): string {
  if (!workerBase || !projectBranch) return "";
  if (workerBase !== projectBranch || showMatching) return `\x1b[90m→ ${workerBase}\x1b[0m`;
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

// Base-branch hint for a project with an explicit baseBranch config key. Unlike
// formatBranchHint, it depends only on the worker's OWN base — there is no
// project-wide sibling toggle (the jitter the explicit key retires). Grey
// "→ base" marks a deliberate per-worker override; yellow marks a genuine fault
// (the base is gone from origin, so the merge will fail); a base matching the
// configured base shows nothing.
function formatConfiguredBaseHint(
  workerBase: string | undefined,
  configuredBase: string,
  missingBases: ReadonlySet<string> | undefined,
): string {
  if (!workerBase) return "";
  if (missingBases?.has(workerBase)) return `\x1b[33m→ ${workerBase}\x1b[0m`;
  if (workerBase !== configuredBase) return `\x1b[90m→ ${workerBase}\x1b[0m`;
  return "";
}

// Grey "⋅<base>" token on a project header when baseBranch is explicitly
// configured — answers "what do this project's workers merge into?" at a
// glance. Nothing on unset (checkout-follows) projects, so an un-migrated
// project's header row is byte-unchanged.
function formatConfiguredBaseToken(project: ProjectConfig | undefined): string {
  return project?.baseBranch ? ` \x1b[90m⋅${project.baseBranch}\x1b[0m` : "";
}

// The distinct set of worker bases actually pinned on rows (drops legacy
// entries with no baseBranch), fed to collectMissingBases.
function definedBases(workers: WorkerInfo[]): string[] {
  return workers.map(w => w.baseBranch).filter((b): b is string => b !== undefined);
}

// A dim-yellow `?` for a worker paused at the human gate (`.garden-awaiting-input`
// present). A status-class flag folded into seg.flags so it never truncates —
// "waiting on you", read at the end of the row like the gate/CI markers.
function formatAwaitingInputGlyph(worker: WorkerInfo): string {
  return worker.awaitingInput ? " \x1b[33m?\x1b[0m" : "";
}

// Dimmed pencil appended to a project's header row when its diary holds
// non-whitespace content — answers "did I leave notes here?", which nothing
// else on the row shows. Intentionally quiet (grey) so it reads as metadata,
// not as a worker-status glyph; placed before the active-project marker.
function formatDiaryGlyph(projectName: string): string {
  return diaryHasContent(projectName) ? " \x1b[90m✎\x1b[0m" : "";
}

// Quiet grey crew badge on the FOCUSED project's header row — which harness/
// provider pair builds and reviews this project's fleet. Same metadata-not-
// status styling as the diary glyph. "custom" when the roles are hand-tuned
// past a named crew. Shown for EVERY crew, including the default `all-claude`
// (operator call, 2026-07-16): the badge rides only the highlighted project
// (renderProjectHeader gates on isActive), so it reads as context for the
// project you're in rather than standing noise across the list — and the
// operator wants the focused project's crew always visible, default or not.
// Read from the already-loaded config, so no extra IO per bake.
function formatCrewBadge(project: ProjectConfig, config: GardenConfig): string {
  return ` \x1b[90m${deriveCrew(project, config) ?? "custom"}\x1b[0m`;
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

// Whether the closed gate actually holds this project's workers — mirrors the
// per-project branch in autoContinueGateReason (poller-merge.ts). A
// usage-triggered closure (pausedUntil set) does not hold projects on a
// separate token pool, so their merged rows must not claim "gate closed";
// an explicit `garden auto off` (no pausedUntil) holds every project.
function gateHoldsProject(ac: AutoContinueConfig, projectName: string, config: GardenConfig): boolean {
  if (ac.enabled) return false;
  if (!ac.pausedUntil) return true;
  return !projectUsageGateExempt(projectName, config);
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
      awaitingInput: isAwaitingInput(entry?.worktreePath),
      failCount: entry?.failCount ?? 0,
      baseBranch: entry?.baseBranch,
      harness: entry?.harness,
      provider: entry?.provider,
      model: entry?.model ?? entry?.trellis?.workerModel,
      workflow: entry?.workflow,
      crew: entry?.crew,
      grow: growInfoFor(entry),
      trellis: trellisInfoFor(entry),
      holisticFinal: entry?.holisticFinalActive,
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
      awaitingInput: isAwaitingInput(entry?.worktreePath),
      failCount: entry?.failCount ?? 0,
      baseBranch: entry?.baseBranch,
      harness: entry?.harness,
      provider: entry?.provider,
      model: entry?.model ?? entry?.trellis?.workerModel,
      workflow: entry?.workflow,
      crew: entry?.crew,
      grow: growInfoFor(entry),
      trellis: trellisInfoFor(entry),
      holisticFinal: entry?.holisticFinalActive,
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

  // One clock read per bake so every row's elapsed suffix — and the state
  // column width derived from it — is consistent.
  const now = Date.now();
  const nameWidth = Math.max(10, ...allWorkers.map(w => w.name.length));
  const statusWidth = computeStatusWidth(allWorkers, now);

  const projectBranches = names.map(n => resolveProjectBranch(n, config));

  // Global auto-continue gate — read once (from the already-loaded config, no
  // extra IO) so `merged` rows can flag when the gate is holding them parked.
  const acConfig = getAutoContinueConfig(config);
  // One alert-store read per bake so every header's ⚠n count is consistent.
  const alertCounts = unreadAlertCountsByProject();
  // Per-row width cap (a 2-column margin for terminals that render the
  // ambiguous-width focus/icon glyphs double-wide). Threaded into renderWorkerRow
  // so the truncation grammar (drop detail, then badges; keep core + flags) runs
  // per row; the trailing .map() cap is the backstop for headers + any overflow.
  // Undefined without paneWidth (the height-only create.ts callers) — rows stay
  // uncapped, and the line COUNT is identical either way.
  const cap = paneWidth && paneWidth > 0 ? Math.max(1, paneWidth - 2) : undefined;

  lines.push("");
  for (let pi = 0; pi < names.length; pi++) {
    if (pi > 0) lines.push("");
    const name = names[pi];
    const projectConfig = config.projects[name];
    const gateClosed = gateHoldsProject(acConfig, name, config);
    const projectBranch = projectBranches[pi];
    lines.push(renderProjectHeader({
      index: pi + 1,
      name,
      isActive: state.activeProject === name,
      projectConfig,
      config,
      alertCount: alertCounts.get(name) ?? 0,
    }));

    const workers = projectWorkers[pi];
    if (workers.length === 0) {
      lines.push("    (no workers)");
    } else {
      const configuredBase = projectConfig?.baseBranch;
      const ctx: RowRenderCtx = {
        now,
        gateClosed,
        projectBranch,
        showAllBranches: configuredBase === undefined
          ? projectHasBranchDivergence(workers, projectBranch)
          : false,
        configuredBase,
        missingBases: configuredBase === undefined
          ? undefined
          : collectMissingBases(name, projectConfig?.path, definedBases(workers)),
        projectMember: projectConfig ? projectWorkerMemberName(projectConfig, config) : "claude",
        projectProvider: projectConfig?.provider,
        projectCrew: projectConfig ? (deriveCrew(projectConfig, config) ?? "custom") : "custom",
      };
      const segments = workers.map(w => collectSegments(w, ctx));
      for (const seg of segments) {
        lines.push(renderWorkerRow(seg, { nameWidth, stateWidth: statusWidth, cap }));
      }
    }
  }
  lines.push("");

  // Backstop cap on every line (headers included) + clear-to-end-of-line so the
  // pane can overwrite in place without a full clear (avoids flashing). Worker
  // rows already fit within `cap` via renderWorkerRow, so this only trims a
  // header that ran long.
  return lines
    .map(l => (cap !== undefined ? truncateToVisibleWidth(l, cap) : l) + "\x1b[K")
    .join("\n");
}
