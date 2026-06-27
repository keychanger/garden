// Default workflow's hook handlers. Reproduces pre-refactor behavior of the
// monolithic handleClaudeHook in header.ts: each Claude Code hook event
// (sessionstart, prompt, notification, pretooluse, posttooluse, stop) maps to
// a method here. The dispatcher in header.ts looks up the worker's workflow
// and calls the appropriate method.
//
// Helpers that were previously private to handleClaudeHook (workerFromCwd,
// readHookInput, findWorkerPaneId, routeStopHookEnd, hasRecentWorkerAlert)
// live here too — they are hook-internal, not part of the dashboard's
// rendering surface, and moving them out of header.ts shrinks that file by
// ~150 lines while keeping all hook logic colocated.
//
// See WORKFLOWS.md Component 5c for the rationale (avoid an import cycle
// through workflows/default.ts and keep handleClaudeHook a true dispatcher).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tryGetProject } from "../../config.js";
import { addAlert, readAlerts } from "../alerts.js";
import { clearDoneSentinel, isDoneSet } from "../continue.js";
import { getWorkerBaseBranch } from "../git.js";
import { findWorkerPaneId, refreshDashboard } from "../header.js";
import { log } from "../log.js";
// Import directly from poller-fifo (leaf module) rather than through
// poller.ts. poller.ts imports getWorkflow from workflows/index.ts; routing
// through it would re-close the workflows/default.ts -> hooks/default.ts ->
// poller.ts -> workflows/index.ts -> workflows/default.ts init cycle.
import { triggerProjectPoll } from "../poller-fifo.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "../registry.js";
import { getPaneTitle } from "../tmux.js";
import { maybeRefreshUsage } from "../usage.js";
import { resolveGardenRunner } from "../runner.js";
import type { HookContext, HookMethod, WorkflowHookHandlers } from "../workflows/types.js";

// ---------------------------------------------------------------------------
// Hook-private helpers
// ---------------------------------------------------------------------------

// Identify the worker from the current working directory. Hooks fire from
// the worktree, so `~/.garden/worktrees/<project>/<worker>/...` cwd uniquely
// identifies the worker. Returns null for ad-hoc invocations that don't
// originate inside a worktree (e.g., `garden dashboard _claude-hook` run by
// hand from the operator's main checkout).
export function workerFromCwd(): { project: string; worker: string } | null {
  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  const prefix = path.join(home, ".garden", "worktrees") + path.sep;
  if (!cwd.startsWith(prefix)) return null;
  const parts = cwd.slice(prefix.length).split(path.sep);
  if (parts.length < 2) return null;
  return { project: parts[0], worker: parts[1] };
}

export function readHookInput(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
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

function routeStopHookEnd(projectName: string, workerName: string): void {
  const project = tryGetProject(projectName);
  if (!project) return;
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return;
  const baseBranch = getWorkerBaseBranch(entry, project.path);
  const cwd = process.cwd();
  try {
    // git rev-list --count <base>..HEAD — counts commits ahead of base.
    // Returns "0" if no commits ahead, a positive number otherwise.
    // 5s timeout: a hung git here stalls the Stop hook AND the entire review
    // pipeline (no pendingReviewAt → no poller poke → worker never advances).
    const out = execFileSync("git", ["rev-list", "--count", `origin/${baseBranch}..HEAD`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    const ahead = parseInt(out, 10);
    if (Number.isFinite(ahead) && ahead > 0) {
      updateWorkerFields(projectName, workerName, { pendingReviewAt: Date.now() });
      triggerProjectPoll(projectName);
      log.info("hook", "stop hook marked pending review", {
        worker: workerName,
        data: { project: projectName, baseBranch, commitsAhead: ahead },
      });
      return;
    }
    // No commits ahead + sentinel present → terminal "done" state, the
    // operator-actionable cleanup signal. STATUS.md invariant 4 path 2:
    // sentinel was set after auto-continue cleared the transient merged.
    if (isDoneSet(entry.worktreePath)) {
      updateWorkerFields(projectName, workerName, {
        prState: "done",
        mergedAt: new Date().toISOString(),
      });
      log.info("hook", "stop hook set done prState", {
        worker: workerName,
        data: { project: projectName },
      });
      // The onStop applyAndLog upstream already wrote agentStatus="idle"
      // and refreshed — but resolveWorkerStatus reads agentStatus only
      // when prState is absent. Without this second refresh the dashboard
      // stays painted as "idle" until the next hook event fires, even
      // though the registry already says "done".
      refreshDashboard();
      // Poke the poller once so handleDone runs. This is the ONLY entry into
      // done for a trail-off completion (the worker finished a multi-phase task
      // without a final merge, so transitionToTerminal — the other holistic
      // trigger site — never ran). handleDone dispatches the holistic review
      // when the gate is eligible; for everything else it is a cheap no-op.
      triggerProjectPoll(projectName);
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

// ---------------------------------------------------------------------------
// Shared apply: every handler funnels into this so logging/refresh/title
// capture stays uniform across hook events.
// ---------------------------------------------------------------------------

type FieldsDelta = Partial<Pick<WorkerEntry,
  "agentStatus" | "lastEventAt" | "lastStateChangeAt" | "prState" | "task" | "transcriptPath">>;

// pretooluse/posttooluse fire on every Claude tool call and dominate hook
// traffic — a busy agent completes many tools per second, and with N agents in
// flight that is N × tool-rate cold-started hook processes. A heartbeat hook
// (one that carries no state change) does a registry read-modify-write under
// the global lock plus the findWorkerPaneId + getPaneTitle tmux forks; doing
// that on every tool call churns the very resources the operator's keystrokes
// and pane swaps share (CPU, the registry lock, the tmux server). So a pure
// heartbeat refreshes liveness at most once per this interval per worker.
const HOOK_HEARTBEAT_MS = 10_000;

function applyAndLog(
  ctx: HookContext,
  fields: FieldsDelta,
  extraLogData?: Record<string, unknown>,
): void {
  if (!ctx.workerInfo) return;

  // Throttle heartbeat-only hooks. Safe because the only consumers of
  // lastEventAt are 15-minute staleness checks (STALE_AGENT_STATUS_MS in
  // poller-review, STALE_EVENT_MS in health) and the task title is
  // independently refreshed by the status render path (refreshWorkerTasks).
  // Every real transition sets agentStatus or prState, so it counts as a
  // state change and always takes the full path below — the STATUS.md state
  // machine is untouched.
  const stateChanged = fields.agentStatus !== undefined || fields.prState !== undefined;
  const now = Date.now();
  if (!stateChanged && now - (ctx.workerInfo.entry.lastEventAt ?? 0) < HOOK_HEARTBEAT_MS) {
    return;
  }
  fields.lastEventAt = now;
  // Row ordering keys on the last real transition, not the heartbeat — so a
  // working agent's silent 10s lastEventAt bumps don't reshuffle the status
  // pane (which only repaints on stateChanged below). See workerSortFreshness.
  if (stateChanged) fields.lastStateChangeAt = now;

  // Capture the transcript path Claude Code reports on the hook input. It
  // rarely changes (once per session), so only write it when it differs —
  // piggybacks on this already-writing path, no extra registry churn. The
  // history view (⌥h) reads it via resolveTranscriptPath.
  const tp = ctx.input.transcript_path;
  if (typeof tp === "string" && tp && tp !== ctx.workerInfo.entry.transcriptPath) {
    fields.transcriptPath = tp;
  }

  // Capture the live pane title as the worker's task summary. Claude sets
  // the title via terminal escape sequences; reading it gives the registry
  // an updated "what is this worker doing" string. Title may be missing at
  // session start or briefly after UserPromptSubmit — leave the previous
  // task field intact in those cases.
  const paneId = findWorkerPaneId(ctx.workerInfo.project, ctx.workerInfo.name);
  if (paneId) {
    const title = getPaneTitle(paneId);
    if (title) fields.task = title;
  }

  try {
    updateWorkerFields(ctx.workerInfo.project, ctx.workerInfo.name, fields);
  } catch (err) {
    log.warn("hook", "failed to update worker for hook event", {
      worker: ctx.workerInfo.name,
      data: { project: ctx.workerInfo.project, event: ctx.event, error: String(err) },
    });
  }

  // Info only when something actually moved: a lifecycle event (sessionstart /
  // prompt / stop) or a agentStatus flip. Raw posttooluse/pretooluse that
  // don't change state are heartbeats — demoted to debug so the default log
  // level shows signal, not the per-tool-call stream.
  const isLifecycle = ctx.event === "sessionstart" || ctx.event === "prompt" || ctx.event === "stop";
  const level = isLifecycle || stateChanged ? "info" : "debug";
  log[level]("hook", "claude hook", {
    worker: ctx.workerInfo.name,
    data: {
      project: ctx.workerInfo.project,
      event: ctx.event,
      agentStatus: fields.agentStatus,
      prStateCleared: fields.prState === undefined && ctx.event === "prompt",
      ...extraLogData,
    },
  });

  // Skip the dashboard cascade when nothing visible changed — pretooluse and
  // posttooluse fire on every Claude tool call and dominate hook traffic, but
  // most don't flip agentStatus (the cs guards above narrow the writes).
  if (stateChanged) refreshDashboard();
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

const onSessionStart: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  const fields: FieldsDelta = {};
  // resume/compact fire mid-turn (auto-compact in particular) and must not clobber working/asking; see STATUS.md.
  const source = typeof ctx.input.source === "string" ? ctx.input.source : "";
  if (source === "resume" || source === "compact") {
    const cs = ctx.workerInfo.entry.agentStatus;
    if (cs !== "working" && cs !== "asking") {
      fields.agentStatus = "ready";
    }
  } else {
    fields.agentStatus = "ready";
  }
  const extraLog = source ? { source } : undefined;
  applyAndLog(ctx, fields, extraLog);
};

const onPromptSubmitted: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  const fields: FieldsDelta = { agentStatus: "working" };
  // Clear merged/done prState on the next prompt — invariant 4 (terminal
  // states are sticky until new input). The hook handler is the only place
  // this clear happens. Also clear the on-disk `.garden-done` sentinel so a
  // subsequent no-commits Stop doesn't immediately re-trip `done` from a
  // prior phase's declaration. If the worker is still done after this turn,
  // the `done` skill re-writes the sentinel.
  const ps = ctx.workerInfo.entry.prState;
  if (ps === "merged" || ps === "done") {
    fields.prState = undefined;
    clearDoneSentinel(ctx.workerInfo.entry.worktreePath);
  }
  applyAndLog(ctx, fields);
};

const onTurnEnded: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  applyAndLog(ctx, { agentStatus: "idle" });
  // routeStopHookEnd reads the registry fresh — the applyAndLog above has
  // already written agentStatus="idle". See STATUS.md invariant 2 (review
  // entry) and invariant 4 (merged stickiness).
  routeStopHookEnd(ctx.workerInfo.project, ctx.workerInfo.name);
  maybeRefreshUsage(resolveGardenRunner());
};

// Fed by both Notification and the PreToolUse matchers (AskUserQuestion /
// ExitPlanMode) — the two wire events signal the same condition.
const onBlockedOnOperator: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  applyAndLog(ctx, midTurnAskingFields(ctx));
};

const onToolActivity: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  // asking → working is the primary path (user answered, Claude resumes).
  // idle → working is a self-heal: a PostToolUse arriving while idle means
  // the turn is still active and our state is stale; trust the event.
  const fields: FieldsDelta = {};
  const cs = ctx.workerInfo.entry.agentStatus;
  if (cs === "asking" || cs === "idle") {
    fields.agentStatus = "working";
  }
  applyAndLog(ctx, fields);
};

// Shared logic for notification / pretooluse: both indicate Claude is
// blocked waiting for user input mid-turn. Accept "working" (normal path)
// or "idle" (self-heal: a user-input tool firing is proof of active turn,
// so idle status is stale).
function midTurnAskingFields(ctx: HookContext): FieldsDelta {
  if (!ctx.workerInfo) return {};
  const cs = ctx.workerInfo.entry.agentStatus;
  if (cs === "working" || cs === "idle") {
    return { agentStatus: "asking" };
  }
  log.info("hook", "mid-turn asking hook skipped (non-working, non-idle)", {
    worker: ctx.workerInfo.name,
    data: { project: ctx.workerInfo.project, event: ctx.event, agentStatus: cs },
  });
  return {};
}

export const defaultHookHandlers: WorkflowHookHandlers = {
  onSessionStart,
  onPromptSubmitted,
  onTurnEnded,
  onBlockedOnOperator,
  onToolActivity,
};
