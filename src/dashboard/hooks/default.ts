// Shared worker hook handlers. Reproduces pre-refactor behavior of the
// monolithic handleClaudeHook in header.ts: each Claude Code hook event
// (sessionstart, prompt, notification, pretooluse, posttooluse, stop) maps to
// a method here. hook-dispatcher.ts translates wire events and invokes them.
//
// Helpers that were previously private to handleClaudeHook (workerFromCwd,
// readHookInput, findWorkerPaneId, routeStopHookEnd, hasRecentWorkerAlert)
// live here too — they are hook-internal, not part of the dashboard's
// rendering surface, and moving them out of header.ts shrinks that file by
// ~150 lines while keeping all hook logic colocated.
//
// These handlers deliberately do not import the workflow registry. Workflow
// state handlers are poller concerns; pulling that registry into this module
// retains the whole review/merge graph in the per-tool-call hook bundle.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tryGetProject } from "../../config.js";
import { addAlert, readAlerts } from "../alerts.js";
import { clearAwaitingInput, clearDoneSentinel, isDoneSet } from "../continue.js";
import { getWorkerBaseBranch } from "../git.js";
import { findWorkerPaneId, refreshDashboard } from "../header.js";
import { log } from "../log.js";
// Import the FIFO wake primitive directly. The hook only signals the poller;
// it must not import poller.ts or any state handler.
import { triggerProjectPoll } from "../poller-fifo.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "../registry.js";
import { getPaneTitle } from "../tmux.js";
import { resolveWorkerActivity } from "../harness/core.js";
import { CODEX_AWAITING_TASK } from "../harness/codex-core.js";
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

// True when `git status --porcelain` reports any tracked or untracked
// (not-gitignored) change; null when the invocation fails, so the caller can
// tell "provably clean" from "couldn't determine". Not git.ts's
// isWorktreeDirty: that helper's 60s git timeout is sized for the poller,
// and a hung git here stalls the Stop hook (see the rev-list call below).
function worktreeHasUncommittedChanges(cwd: string): boolean | null {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.trim().length > 0;
  } catch {
    return null;
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
      // The reviewer certifies the committed snapshot of this same worktree,
      // so a Stop that fires mid-work — an agent pausing to answer an operator
      // question with uncommitted WIP on disk — must not queue a review: it
      // would review a stale tree and force-push under live edits. Skip when
      // any tracked or untracked change exists; the next clean-tree Stop
      // re-arms. When cleanliness cannot be established, fail closed the same
      // way. handleWorking re-checks at launch for the residual window where
      // an earlier clean Stop's pendingReviewAt outlives a later dirty tree.
      const dirty = worktreeHasUncommittedChanges(cwd);
      if (dirty !== false) {
        const level = dirty === null ? "warn" : "info";
        log[level]("hook", "stop hook skipped review (worktree not provably clean)", {
          worker: workerName,
          data: {
            project: projectName,
            commitsAhead: ahead,
            dirty: dirty === null ? "indeterminate" : true,
          },
        });
        return;
      }
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
  "agentStatus" | "lastEventAt" | "lastStateChangeAt" | "prState" | "task" | "transcriptPath" | "sessionId" | "continueSentAt">>;

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
  // lastEventAt are coarse staleness checks measured in tens of minutes
  // (STALE_AGENT_STATUS_MS in poller-review, 60 min; STALE_EVENT_MS in
  // health, 15 min) — both far above this throttle — and the task title is
  // independently refreshed by the status render path (refreshWorkerTasks).
  // Every real transition sets agentStatus or prState, so it counts as a
  // state change and always takes the full path below — the STATUS.md state
  // machine is untouched.
  const stateChanged = fields.agentStatus !== undefined || fields.prState !== undefined;
  const now = Date.now();
  const activityUnset = ctx.workerInfo.entry.harness === "codex"
    && (!ctx.workerInfo.entry.task
      || ctx.workerInfo.entry.task === CODEX_AWAITING_TASK
      || ctx.workerInfo.entry.task === ctx.workerInfo.entry.name);
  if (!stateChanged && !activityUnset
      && now - (ctx.workerInfo.entry.lastEventAt ?? 0) < HOOK_HEARTBEAT_MS) {
    return;
  }
  fields.lastEventAt = now;
  // Row ordering keys on the last real transition, not the heartbeat — so a
  // working agent's silent 10s lastEventAt bumps don't reshuffle the status
  // pane (which only repaints on stateChanged below). See workerSortFreshness.
  if (stateChanged) fields.lastStateChangeAt = now;

  // Capture the transcript path the harness reports on the hook input. It
  // rarely changes (once per session), so only write it when it differs —
  // piggybacks on this already-writing path, no extra registry churn. The
  // history view (⌥h) reads it via resolveTranscriptPath, and for a Codex
  // worker codex-input.ts watches it for asking/turn-end reconciliation.
  // Ownership guard: Codex fires the relay for subagent threads it spawns, and
  // their events carry the SUBAGENT's rollout path — capturing it pointed the
  // history view, readActivity, and the asking/turn-end reconciler at a side
  // thread instead of the worker's conversation. Both harnesses embed the
  // session id in the transcript filename (claude `<id>.jsonl`, codex
  // `rollout-<ts>-<id>.jsonl`), so a path that doesn't name the worker's own
  // session belongs to some other thread and is skipped. With no session id
  // known yet, validate against the id from this payload when present; that
  // is also the id captured below.
  const tp = ctx.input.transcript_path;
  const ownSession = ctx.workerInfo.entry.sessionId;
  const reportedSession = typeof ctx.input.session_id === "string"
    ? ctx.input.session_id
    : "";
  const transcriptSession = ownSession || reportedSession;
  const transcriptName = typeof tp === "string" ? path.basename(tp) : "";
  const ownsTranscript = !transcriptSession
    || transcriptName === `${transcriptSession}.jsonl`
    || (transcriptName.startsWith("rollout-")
      && transcriptName.endsWith(`-${transcriptSession}.jsonl`));
  if (typeof tp === "string" && tp && tp !== ctx.workerInfo.entry.transcriptPath
      && ownsTranscript) {
    fields.transcriptPath = tp;
  }

  // Capture the session id ONLY when the worker has none yet — the case of a
  // harness that assigns its own id (Codex) rather than accepting a
  // garden-minted one (Claude Code, whose sessionId is set at creation). This
  // is what makes bounce/resume work for such a worker: buildResumeCommand
  // reads entry.sessionId to `codex resume <id>`. Guarded on empty so a
  // claude worker's id is never overwritten mid-session.
  const sid = reportedSession;
  if (typeof sid === "string" && sid && !ctx.workerInfo.entry.sessionId) {
    fields.sessionId = sid;
  }

  // Refresh the worker's task summary. Claude Code sets the pane title via
  // terminal escape sequences as it works, so reading it gives an updated
  // "what is this worker doing" string; a harness whose title carries no such
  // summary (Codex) reads its own transcript instead. Either source may come
  // back empty — at session start, briefly after UserPromptSubmit, or before
  // the agent has said anything — so leave the previous task field intact then.
  const summary = resolveWorkerActivity(ctx.workerInfo.entry, () => {
    const paneId = findWorkerPaneId(ctx.workerInfo!.project, ctx.workerInfo!.name);
    return paneId ? getPaneTitle(paneId) : null;
  });
  const taskChanged = Boolean(summary && summary !== ctx.workerInfo.entry.task);
  if (summary) fields.task = summary;

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
  if (stateChanged || taskChanged) refreshDashboard();
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

const onSessionStart: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  const fields: FieldsDelta = {};
  const source = typeof ctx.input.source === "string" ? ctx.input.source : "";
  if (source === "resume" || source === "compact") {
    // A resumed or auto-compacted session has already received input, so per
    // STATUS.md it must NEVER return to the one-time "ready" state. On a rebuild
    // or bounce the resume dispatcher (create.ts / bounceWorker via
    // resolveResumeAgentStatus) has already written this worker's authoritative
    // post-resume status; auto-compaction fires mid-turn and carries the live
    // status. Preserve it — writing "ready" here is what stranded resumed
    // idle/done workers in the "new" band. Only self-heal a missing value.
    if (ctx.workerInfo.entry.agentStatus === undefined) {
      fields.agentStatus = "idle";
    }
  } else {
    fields.agentStatus = "ready";
  }
  const extraLog = source ? { source } : undefined;
  applyAndLog(ctx, fields, extraLog);
};

const onPromptSubmitted: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  // A landed prompt (garden's own or the operator's) means the input box was
  // submitted or superseded — clear the garden-paste marker so a later draft
  // can't be misread as garden's stuck paste (continue.ts isOwnStuckPaste).
  const fields: FieldsDelta = { agentStatus: "working", continueSentAt: undefined };
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
  // Clear the human-gate sentinel unconditionally: a worker paused for operator
  // input (botanist/plan) holds it while prState is still `working`, so unlike
  // the done-sentinel its clear is not gated on a terminal prState. The
  // operator's prompt is the resume signal.
  clearAwaitingInput(ctx.workerInfo.entry.worktreePath);
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
  // No Codex usage capture here: the meter is fed role-agnostically from the
  // watchdog tick (codex-usage.ts captureCodexUsageLatest), since the headless
  // reviewer/resolver/ci-fix roles spend Codex quota without firing any hook.
};

// Fed by both Notification and the PreToolUse matchers (AskUserQuestion /
// ExitPlanMode) — the two wire events signal the same condition.
const onBlockedOnOperator: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  applyAndLog(ctx, midTurnAskingFields(ctx));
};

const onToolActivity: HookMethod = (ctx) => {
  if (!ctx.workerInfo) return;
  // asking → working is the primary path (user answered, Claude resumes) —
  // including the permission-approval case, where the approved tool can be any
  // tool at all, which is why the PostToolUse matcher is a catch-all.
  // idle → working is a self-heal: a PostToolUse arriving while idle means
  // the turn is still active and our state is stale; trust the event.
  //
  // Both readings hold only for the worker's OWN thread. Claude Code fires the
  // parent session's PostToolUse for subagent tool calls too, and a subagent
  // runs concurrently with a main thread that may be blocked on the operator
  // or parked after Stop — so its activity is no evidence about either. Left
  // in, a background agent silently cleared `asking` (dropping the yellow row
  // that is the operator's only signal the worker needs them) and re-raised a
  // false `working` after Stop (which defers the merge gate via
  // isWorkerClaudeWorking). Only agent_id separates the two: session_id and
  // transcript_path are byte-identical on both, so the transcript-ownership
  // guard in applyAndLog cannot see this.
  const fields: FieldsDelta = {};
  const cs = ctx.workerInfo.entry.agentStatus;
  if (!isSubagentEvent(ctx) && (cs === "asking" || cs === "idle")) {
    fields.agentStatus = "working";
  }
  applyAndLog(ctx, fields);
  // Deliberately outside the guard: a subagent's Edit rewrites the same
  // worktree the reviewer is certifying, so the cancel is owed either way.
  markReviewInterrupted(ctx);
};

// True when this tool event came from a subagent rather than the worker's main
// conversation thread. `agent_id` is documented as present only on subagent
// tool events; the raising side (onBlockedOnOperator) deliberately does not
// consult it, since a subagent's permission request blocks the operator just
// as a main-thread one does — raising the flag on either is right, clearing it
// on unrelated activity is not.
function isSubagentEvent(ctx: HookContext): boolean {
  return typeof ctx.input.agent_id === "string" && ctx.input.agent_id.length > 0;
}

// Tools that rewrite the worktree. Bash is deliberately absent: a worker
// answering an operator question mid-review runs read-only Bash (git log, rg)
// far more often than it mutates through Bash alone, and the commit/push
// backstops in poller-review catch a Bash-only mutator one turn later.
const MUTATING_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// A mutating tool completing while this worker's review is in flight means
// the reviewer — which shares the worker's worktree — is now certifying a
// tree being rewritten under it (the operator prompted the worker mid-review;
// the reviewer's own tool calls never reach here, GARDEN_REVIEWER=1
// short-circuits in the dispatcher). Stamp the interruption and poke the
// poller; the cancel itself is the poller's job — hooks write agentStatus,
// the poller writes prState.
function markReviewInterrupted(ctx: HookContext): void {
  if (!ctx.workerInfo) return;
  const { project, name, entry } = ctx.workerInfo;
  if (entry.prState !== "reviewing" || entry.reviewInterruptedAt) return;
  const toolName = ctx.input.tool_name;
  if (typeof toolName !== "string" || !MUTATING_TOOLS.has(toolName)) return;
  updateWorkerFields(project, name, { reviewInterruptedAt: Date.now() });
  triggerProjectPoll(project);
  log.info("hook", "mutating tool during review, marked for cancel", {
    worker: name,
    data: { project, tool: toolName },
  });
}

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

export const workerHookHandlers: WorkflowHookHandlers = {
  onSessionStart,
  onPromptSubmitted,
  onTurnEnded,
  onBlockedOnOperator,
  onToolActivity,
};
