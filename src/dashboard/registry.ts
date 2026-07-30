// Worker registry: persistent record of living workers across dashboard restarts.
//
// Concurrency model: the registry file is read/modified/written as a unit.
// Multiple processes (poller, hooks, dashboard commands) can write at the
// same instant. To prevent lost updates, every read-modify-write cycle holds
// an exclusive file lock for the duration. The lock is a sibling .lock file
// created with O_CREAT|O_EXCL. Stale locks (holder PID dead) are reclaimed.
// See STATUS.md "Detection machinery" — the registry is the single source of
// truth, so it must be race-free.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import { addAlert } from "./alerts.js";
import { log } from "./log.js";

// agentStatus is written by Claude Code hooks, the tmux pane-died handler, and
// the operator `hold` action (which writes "paused"). prState is written by
// the poller. There are no other writers. See STATUS.md.
export type AgentStatus = "loading" | "ready" | "working" | "asking" | "idle" | "paused" | "exited";
export type PrState = "working" | "reviewing" | "merge-pending" | "resolving" | "ci-fixing" | "merged" | "done" | "failing";

// Operational classification of each prState, the single source of truth for
// "what does the poller owe this worker?" Consumers (today: the liveness
// watchdog) derive their state sets from this table instead of re-listing
// states inline, so adding a PrState to the union forces a classification
// decision here — the Record has no index signature, so an unclassified state
// is a compile error, not a silently un-watched worker.
//
// - pollerOwed: the poller owes a future action, so a dropped one-shot event
//   (a poke lost in the poller kill->spawn gap, a reboot-killed delayed poke)
//   would strand the worker. The watchdog watches these. The quiescent states
//   (`working`, `failing`, `done`) park legitimately: `working` is driven by
//   the worker's own Claude hook firehose, `failing`/`done` wait on operator
//   action — each carries its own future event, so none is owed a poke.
// - windowed: the owed action runs in a hidden tmux window whose name lives in
//   entry.reviewWindowName, so its liveness is probeable. A live window is
//   proof the work is in flight (not stranded) and bounded by its own timeout;
//   merge-pending/merged do their work inline with no window to probe.
export const PR_STATE_KIND: Record<PrState, { pollerOwed: boolean; windowed: boolean }> = {
  working: { pollerOwed: false, windowed: false },
  reviewing: { pollerOwed: true, windowed: true },
  resolving: { pollerOwed: true, windowed: true },
  "ci-fixing": { pollerOwed: true, windowed: true },
  "merge-pending": { pollerOwed: true, windowed: false },
  merged: { pollerOwed: true, windowed: false },
  failing: { pollerOwed: false, windowed: false },
  done: { pollerOwed: false, windowed: false },
};

// Trellis reviewer verdict vocabulary. See WORKFLOWS.md "Reviewer prompt and
// verdict". Persisted on WorkerEntry.trellis.lastVerdict for trellis vines.
export type TrellisVerdict = "ALIGNED" | "DRIFT" | "FAILED" | "FLAGGED";

// Reason a worker is in `failing`. Allowed values per WORKFLOWS.md
// "Worker entry additions" + "Equilibrium and termination". Default
// workflow uses "code" and "unparseable-verdict"; trellis adds the rest.
// Optional: legacy entries lack this field; consumers default to "code"
// when absent on a `failing` worker.
export type FailingReason =
  | "code"
  | "trellis-flagged"
  | "iteration-budget"
  | "stagnation"
  | "unparseable-verdict"
  // Set by handleTransientReviewFailure after the auto-retry budget for
  // transient API errors (5xx, 429, overloaded_error) is exhausted. Distinct
  // from "unparseable-verdict" because the code is not at fault — the
  // reviewer's Claude process couldn't even reach the API. `garden kick`
  // accepts this reason and re-queues the review without requiring new
  // commits (see commands/kick.ts).
  | "transient-review"
  // Set by handleQuotaLimitReview after the reviewer hit the Claude session/
  // usage QUOTA cutoff (the operator's rolling window) and the ~6h auto-retry
  // budget was exhausted. Distinct from "transient-review" (a seconds-scale API
  // blip): the reviewer's Claude was cut off before emitting a verdict and the
  // window resets on an hours scale, so the review auto-retries every ~15 min
  // until it clears. `garden kick` accepts this reason and re-queues the review
  // with no new commit (see commands/kick.ts).
  | "quota"
  // Set by the poller's CI gate (poller-ci.ts) when GitHub Actions reports
  // any failed/cancelled/timed-out check-run on the worker's branch HEAD.
  // The merge is held until the operator pushes a new commit that turns
  // the check green; the poller does not auto-retry.
  | "ci"
  // Set by launchReview (poller-review.ts) when the assembled reviewer prompt
  // exceeds MAX_REVIEW_PROMPT_BYTES — the branch diff is larger than any
  // reviewer's context window, so the agent CLI rejects the prompt before the
  // reviewer starts and no retry can help. NOT an operator-action reason:
  // splitting the oversized commit rewrites the branch, and the resulting SHA
  // re-enters review through the normal failing debounce. `garden kick` does
  // NOT accept it — kicking an unchanged diff re-fails identically.
  | "oversized-diff"
  // Set by handleWorking's skip-review path (poller-review.ts) when a botanist
  // (skipsReviewMerge) branch committed files outside the publishable docs/
  // boundary — a botanist that drifted into building code. NOT an operator-
  // action reason: removing the offending files and re-pushing auto-retries the
  // publish after the failing debounce.
  | "botanist-scope";

// Failing reasons that park the worker until the operator runs a specific
// command (a trellis disposition) — pushing new commits does NOT auto-resume
// them. Both the failing-state debounce (handleFailing) and the watchdog's
// failing-debounce backstop (isWatchedState) skip these so a parked worker is
// left alone. Every other reason follows the "push a fix, it re-reviews after
// the debounce" path.
export const OPERATOR_ACTION_FAILING_REASONS: ReadonlySet<FailingReason> = new Set([
  "trellis-flagged", "iteration-budget", "stagnation",
]);

// Durable record of the worker's most recent completed review, kept so
// `garden review <worker>` can show what the reviewer decided and changed
// without digging through logs. Written at verdict dispatch (handleReviewing)
// and deliberately NOT cleared by the merge/failing resets — unlike the
// transient lastReviewBody/preReviewSha, which those resets scrub — so it
// survives into `merged`/`done`. `preReviewSha`..`tipSha` is the review-window
// delta: the reviewer's own edits when the base held still, but it also captures
// base advancement if the reviewer rebased onto a sibling merge mid-review.
export interface LastReviewData {
  verdict: string;        // clean | fixed | failed | ALIGNED | DRIFT | ... (workflow verdict vocab)
  at: number;             // epoch ms of the verdict dispatch
  body: string;           // reviewer output body, capped to a tail
  preReviewSha?: string;  // worker HEAD the reviewer started from
  tipSha?: string;        // HEAD after the reviewer ran (the reviewed tip)
}

export interface WorkerEntry {
  name: string;       // adjective-noun name, e.g. "swift-oak"
  sessionId: string;  // claude session UUID for direct resume
  task: string;       // last known task summary from pane title
  // Path to this session's Claude Code transcript JSONL, captured from the
  // hook input (`transcript_path`). Read by the history view (⌥h) to
  // render the operator's prompt history. Optional: derivable from
  // worktreePath + sessionId when unset (see resolveTranscriptPath).
  transcriptPath?: string;
  worktreePath?: string;
  branchName?: string;
  // Base branch pinned at worker creation. Set by newWorker() after verifying
  // origin/<baseBranch> exists. All consumers (poller, Stop hook, kick, resume)
  // must prefer this over re-resolving from projectConfig/main-checkout —
  // otherwise the worker silently breaks when the main checkout is switched
  // to a local-only branch. Optional only for backward compat with workers
  // created before this field existed; new workers always set it.
  baseBranch?: string;
  prState?: PrState;
  lastSeenSha?: string;
  lastShaChangeAt?: string;
  mergedAt?: string;
  failCount?: number;
  failingSha?: string;
  agentStatus?: AgentStatus;
  lastEventAt?: number;    // epoch ms when a Claude hook last fired for this worker
  // Epoch ms of the worker's last *meaningful* state change — an agentStatus or
  // prState transition, not the 10s hook heartbeat. Drives row ordering
  // (workerSortFreshness) so the list only reshuffles when the worker actually
  // moves, never on the silent heartbeat that bumps lastEventAt without a
  // repaint, and the status pane's time-in-state suffix (how long a worker has
  // sat in its current state). Stamped by applyAndLog on an agentStatus change
  // (hook side) and by transitionState on a prState change (poller side);
  // backfilled in migrateLastStateChangeAt for entries that predate the field.
  lastStateChangeAt?: number;
  // Epoch ms when the worker was created (set in addWorker). Acts as the floor
  // for a brand-new worker's freshness before its first hook fires, so a
  // just-made worker sorts fresh instead of sinking to the bottom. Optional
  // only for backward compat: old entries are backfilled in migrateCreatedAt.
  createdAt?: number;
  // Set by the worker's Stop hook when it sees commits ahead of base. The
  // poller's handleWorking gates launchReview on this — without it, an idle
  // worker with stale commits would be reviewed on every FIFO poke. Cleared
  // when launchReview runs. Per STATUS.md invariant 2: "working is the only
  // entry point to the review cycle" — pendingReviewAt makes that explicit.
  pendingReviewAt?: number;
  // Epoch ms when a mutating tool call (Edit/Write) completed on the worker
  // while its review was in flight (stamped by hooks/default.ts). The reviewer
  // shares the worker's worktree, so the tree under review is being rewritten;
  // handleReviewing cancels the pass and resets to working — the re-review
  // happens at quiescence via the worker's next Stop. Cleared by the cancel
  // and defensively at every review launch (a marker stamped in the instant
  // between verdict dispatch and the poll would otherwise leak forward).
  reviewInterruptedAt?: number;
  reviewWindowName?: string;
  // Epoch ms when the current reviewer/resolver window was launched. Set by
  // launchReview/launchResolver, cleared whenever reviewWindowName is cleared.
  // The poller uses this to enforce REVIEW_TIMEOUT_MS — a reviewer stuck on a
  // hung subprocess (e.g. tests with no timeout blocked by the sandbox) is
  // killed and escalated to `failing` rather than wedging the state machine.
  reviewStartedAt?: number;
  mergePendingAt?: string;
  lastReviewBody?: string;
  // Durable last-review record for `garden review` (see LastReviewData). Set at
  // verdict dispatch, survives the merge/failing resets. Distinct from
  // lastReviewBody (transient, feeds the "previous review" prompt).
  lastReview?: LastReviewData;
  // Resolver state (see STATUS.md invariants 7 and 8). preResolveSha is the
  // HEAD SHA captured the moment before the resolver launches — the poller
  // compares post-resolver HEAD against it to confirm the resolver actually
  // committed something. resolveAttempts counts resolver launches for the
  // current merge; budget is 2, resets on worker push or successful merge.
  // lastResolveBody carries the resolver's last output body for alert text.
  preResolveSha?: string;
  resolveAttempts?: number;
  lastResolveBody?: string;
  // CI-fix state (see poller-ci-fix.ts). preCiFixSha is the HEAD SHA captured
  // before the ci-fix agent launches; the poller verifies the agent actually
  // pushed by comparing post-agent HEAD against it. ciFixAttempts counts
  // launches for the current merge; budget is 3, resets on worker push or
  // successful merge. lastCiFixBody carries the agent's last output body for
  // alert text. failingCheckSummary is the formatted list of failed
  // check-runs (name + conclusion) seeded into the agent's prompt.
  preCiFixSha?: string;
  ciFixAttempts?: number;
  lastCiFixBody?: string;
  failingCheckSummary?: string;
  // Local HEAD SHA captured when a review is launched. Used by handleReviewing
  // to detect whether the reviewer actually committed anything (rebase + fixes)
  // so that an unparseable verdict with real work attached can be recovered
  // instead of silently discarded.
  preReviewSha?: string;
  // CI-gate grace stamp: when the gate first saw zero check-runs on this SHA,
  // on a project that HAS CI. Bounds the "not yet materialized" defer (see
  // CI_NO_RUNS_GRACE_MS, poller-merge.ts). Persisted per-worker rather than
  // held in a poller-module Map because the poller loop execs a FRESH process
  // per poll (`while true; do garden dashboard _poll; read; done`) — an
  // in-memory stamp was re-created as "now" on every poll, so the elapsed check
  // measured ~0ms forever and the merge deferred permanently. Keyed by sha so a
  // force-push (reviewer fix, ci-fix) starts a fresh window on its own commit.
  ciNoRuns?: { sha: string; since: number };
  // Set when handleReviewing receives an unparseable verdict but the reviewer
  // advanced HEAD; the poller force-pushes and re-queues one more review. A
  // second unparseable verdict falls through to the normal failing path.
  // Cleared on any parseable verdict (clean/fixed/failed).
  unparseableReviewAt?: number;
  // Transient-review retry state. Set by handleTransientReviewFailure when the
  // reviewer output ends in an API error (5xx, 429, overloaded_error) and the
  // reviewer didn't commit anything. reviewRetryCount tracks attempts in the
  // current review cycle; the budget (MAX_TRANSIENT_REVIEW_RETRIES) is 3.
  // reviewRetryAt is the earliest epoch ms at which handleWorking is permitted
  // to relaunch the review — backoff is 30s / 2m / 5m. Both fields clear on
  // any parseable verdict and on a successful review launch. See
  // poller-review.ts handleTransientReviewFailure / handleWorking.
  reviewRetryCount?: number;
  reviewRetryAt?: number;
  // Quota-review retry state. Parallels reviewRetryCount but on the session/
  // usage-quota schedule: set by handleQuotaLimitReview when the reviewer hit
  // the Claude session limit, budget MAX_QUOTA_REVIEW_RETRIES (24) on a flat
  // ~15-min cadence (~6h ceiling). Reuses reviewRetryAt as the cause-agnostic
  // relaunch gate (only one review is ever pending), but keeps its own budget
  // so a fast transient blip and an hours-scale quota wait can't conflate.
  // Clears wherever reviewRetryCount clears. See poller-review.ts
  // handleQuotaLimitReview.
  quotaRetryCount?: number;
  // Unparseable-verdict retry state. Set by handleUnparseableReview when the
  // reviewer ended its turn with no parseable verdict AND committed nothing
  // (a benign one-off flake — the reviewer emitted prose instead of a
  // CLEAN/FIXED/FAILED token). Budget MAX_UNPARSEABLE_REVIEW_RETRIES (2) on a
  // short flat backoff (UNPARSEABLE_REVIEW_BACKOFF_MS); past it the worker
  // parks in `failing` with failingReason="unparseable-verdict"
  // (kick-recoverable). Reuses reviewRetryAt as the cause-agnostic relaunch
  // gate, but keeps its own budget so a fast flake and the transient/quota
  // waits can't conflate. Clears wherever reviewRetryCount clears. See
  // poller-review.ts handleUnparseableReview. Distinct from unparseableReviewAt
  // above, which is the one-shot marker for the reviewer-committed-work path.
  unparseableRetryCount?: number;
  // Reviewer quota fallback. Set to the fallback harness ("claude-code") by
  // handleQuotaFallbackReview when the project's configured FOREIGN reviewer
  // (e.g. codex) is quota-blocked: a foreign subscription window resets on a
  // multi-day scale, so waiting it out would wedge the whole merge pipeline.
  // While set, launchReview pins this review cycle to the first-party Opus
  // safety net (harness + neutralizing env + Opus) regardless of project.roles,
  // and it marks the relaunch as a retry so the loop iteration counter is not
  // re-incremented. Persists across the fallback review's own transient/quota
  // retries; clears wherever reviewRetryCount clears (any parseable verdict,
  // worker push, or terminal). The next fresh cycle re-tries the configured
  // reviewer, so codex resumes automatically once its window resets. See
  // poller-review.ts handleQuotaFallbackReview / launchReview.
  reviewFallbackHarness?: string;
  // Set by handlePaneDied when agentStatus was "working" at the moment the
  // pane died (dashboard kill, tmux server gone). Read by ensureDashboard's
  // resume loop to decide whether to auto-send a "continue" prompt after the
  // worker is brought back via `claude --resume`. Cleared by _continue-worker
  // once the prompt is dispatched.
  interruptedWhileWorking?: boolean;
  // Set by finalizeMerge after dispatching the post-merge auto-continue prompt.
  // Idempotency guard: if a merge event somehow replays within a short window,
  // we don't double-fire the continue. See dashboard/continue.ts and STATUS.md.
  lastAutoContinueAt?: number;
  // Transient payload for the post-merge auto-continue prompt. finalizeMerge
  // diffs preReviewSha against the merged tip and stores the changed-file list
  // here; continueWorkerAfterMerge reads it to enrich the prompt and clears it
  // after sending. pendingContinueSyncFailed signals that the post-merge
  // worktree sync was skipped (dirty or git failure) so the prompt can tell
  // the worker to sync manually. Both fields live only across the brief
  // finalizeMerge → detached-subprocess → send-keys window.
  pendingContinueChangedFiles?: string[];
  pendingContinueSyncFailed?: boolean;
  // Holistic post-merge review plumbing. A multi-phase default worker that
  // reaches `done` having merged >=2 times gets one whole-task coherence
  // review (see docs/STATUS.md and poller-holistic-review.ts). All five
  // fields are flat (cross-workflow scalars, not per-workflow sub-objects) and
  // optional — absent on legacy entries; no readRegistry migration is needed
  // (gates read `?? 0` / `?? "default"`).
  //
  //  - mergeCount: completed-merge counter, +1 per merge in transitionToTerminal.
  //    The `>=2` gate. NOT incremented on grow's direct-done path (which bypasses
  //    transitionToTerminal), so grow/trellis are excluded by both the workflow
  //    clause and (for grow) the increment site.
  //  - baseBranchSha: origin/<baseBranch> tip captured at worker creation — the
  //    `from` endpoint of the whole-task cumulative diff.
  //  - holisticTouchedFiles: union of each cycle's preMergeChangedFiles; scopes
  //    the cumulative diff to files this worker actually touched.
  //  - holisticReviewedThroughMergeCount: high-water-mark guard. Dispatch fires
  //    when mergeCount>=2 && (reviewedThrough ?? 0) < mergeCount, so it is
  //    idempotent against a replayed `done` at the same count yet re-arms if a
  //    re-opened worker adds more phases.
  //  - holisticRationale: cross-phase commit log captured at dispatch; seeds the
  //    aggregated final-review prompt (the deliberate-decision guardrails).
  //
  // The final holistic review is NOT a separate spawned worker: the dispatcher
  // interposes one aggregated review pass on THIS worker's own branch (reusing
  // the headless reviewer flow) before it settles into terminal `done`. Two
  // transient markers drive that pass; both are cleared when it resolves:
  //  - holisticFinalActive: true while the worker sits in `reviewing` for its
  //    interposed final pass (not a per-phase review). handleReviewing early-
  //    returns to the holistic verdict handler on it; transitionToTerminal routes
  //    a resulting fix merge straight to `done` (guard bumped, no auto-continue).
  //  - holisticReviewMode: "fix" (reviewer fixes cross-phase defects directly) or
  //    "shadow" (reports findings only, never commits) — the active mode for the
  //    in-flight pass, read by the prompt and the verdict handler.
  mergeCount?: number;
  baseBranchSha?: string;
  holisticTouchedFiles?: string[];
  holisticReviewedThroughMergeCount?: number;
  holisticRationale?: string;
  holisticFinalActive?: boolean;
  holisticReviewMode?: "fix" | "shadow";
  role?: string;
  // Handoff lineage. `parentWorker` + `parentProject` are set by newWorker on
  // workers created via `garden handoff` so the child knows where it came
  // from. When `handoffCallbackExpected` is also true (caller passed
  // --expect-callback), transitionState fires a one-shot callback prompt at
  // the parent's pane the first time the child reaches a terminal prState
  // (merged/done/failing). handoffCallbackFiredAt records when that dispatch
  // happened — it's the idempotency guard so a replayed terminal transition
  // doesn't double-fire. handoffReplyNote is an optional freeform string the
  // child can attach via `garden reply` before terminating; it gets inlined
  // into the callback prompt. All five fields are absent on non-handoff
  // workers.
  parentWorker?: string;
  parentProject?: string;
  handoffCallbackExpected?: boolean;
  handoffCallbackFiredAt?: number;
  handoffReplyNote?: string;
  // Workflow definition that drives this worker's lifecycle (state machine,
  // state handlers, hook routing). Set to "default" by newWorker. Absent on
  // legacy entries from before the workflow registry shipped — consumers
  // (poller, transitionState, hook dispatcher) read with `entry.workflow ?? "default"`.
  // See WORKFLOWS.md and src/dashboard/workflows/.
  workflow?: string;
  // Harness adapter that drives this worker's agent CLI (launch dialect,
  // runtime config, transcript format, prompt delivery). Absent =
  // "claude-code" — consumers read with `getHarness(entry.harness)`,
  // mirroring the `entry.workflow ?? "default"` pattern. No spawn-time
  // selector exists yet; the field lands ahead of the second adapter so
  // resume/bounce/loop paths thread it from day one.
  // See docs/MULTI-MODEL.md "Layer 3".
  harness?: string;
  // Per-worker provider backend (axis 1, the `harness` analog for axis 2) —
  // the Anthropic-Messages-compatible endpoint this worker's claude-code
  // session runs against, set when its build member carries one (`deepseek`).
  // Absent = the project's `provider` key, which remains the default for every
  // worker that did not name a member. The EMPTY string is distinct from
  // absent: it means the worker's member named no provider — explicitly
  // first-party — and must CLEAR a provider-backed project's key rather than
  // inherit it, or `claude` on such a project would launch against the
  // provider anyway (see `workerProject` in create.ts, the one decoder).
  // Read by the launch/resume/bounce env
  // builders (`workerEnvPrefix`) and by the usage gate, both of which resolve
  // it through the same `resolveProvider` the project key uses — a worker on a
  // provider spends a token pool the Claude meters do not describe, exactly
  // like a provider-backed project. NEVER consulted for the review family:
  // reviewer/resolver/ci-fix stay first-party by construction (a provider on
  // review defeats the safety net). See docs/MULTI-MODEL.md "Layer 1".
  provider?: string;
  // Per-worker model, set via `--model` at creation for default and grow
  // workers. Opaque string: an Anthropic alias ("opus"/"sonnet" — resolved
  // through the provider's modelMap on provider-backed projects) or any
  // concrete model id the backend accepts. Threaded into every launch,
  // respawn, and bounce so the pin survives the worker's lifetime. Trellis
  // vines use `trellis.workerModel` instead (iteration-resolved with the
  // Sonnet-exhaustion fallback). See docs/MULTI-MODEL.md "Layer 2".
  model?: string;
  // Per-worker crew (`workers new --crew`). Names a crew
  // (see crew.ts). Its BUILD half is resolved into entry.harness/provider at
  // spawn; its REVIEW half is applied live by resolveReviewRole (roles.ts),
  // which layers the crew's review harness ahead of project.roles — so changing
  // entry.crew re-targets the next review/resolve/ci-fix. Absent on legacy
  // entries and workers spawned without --crew; no readRegistry migration
  // needed (a top-level scalar rides Object.assign; consumers read `?? …`).
  crew?: string;
  // Ultracode preset flag, set via `garden handoff --ultracode`. When true,
  // the worker launches in Claude Code's ultracode mode: `--effort max` plus
  // `ultracodeKeywordTrigger: on` (the dynamic-workflow standing opt-in),
  // rendered by the harness buildAgentCommand. The paired Opus pin lives on
  // `model` above (stamped at creation). Threaded into every launch, resume,
  // and bounce so the mode survives the worker's lifetime.
  ultracode?: boolean;
  // Per-worker reasoning effort (one of WORKER_EFFORT_LEVELS: low/medium/high/
  // xhigh), set via the ⌥⇧N composer's effort dim or `workers new --effort`.
  // Rendered by the harness buildAgentCommand as `--effort <level>`; threaded
  // into every launch/resume/bounce like `model`. The top rung (max effort +
  // dynamic workflows) is the `ultracode` flag above, not an effort value, so
  // the two never co-occur. Default/grow only (trellis resolves its own model
  // and does not carry effort). A top-level scalar — no readRegistry migration.
  effort?: string;
  // Reason the worker is in `failing`. See FailingReason above and
  // WORKFLOWS.md "Equilibrium and termination". Default workflow sets "code"
  // (Q8 retrofit) or "unparseable-verdict" (Q9 retrofit, phase 2).
  failingReason?: FailingReason;
  // Trellis-vine-only data. Populated only when workflow === "trellis";
  // absent on default workers. Migration of legacy flat trellis* fields
  // happens in readRegistry. updateWorkerFields deep-merges this sub-object
  // (passing `{ trellis: { lastVerdict: "ALIGNED" } }` updates only that
  // one key without clobbering the rest). See WORKFLOWS.md "Worker entry
  // additions" for field contracts.
  trellis?: TrellisData;
  // Grow-loop-only data. Populated only when workflow === "grow"; absent
  // on default and trellis workers. updateWorkerFields deep-merges this
  // sub-object (same pattern as `trellis`).
  grow?: GrowData;
}

/** Trellis-workflow per-worker data. All fields except `name` and `path`
 *  are runtime mutations the poller writes during the review loop. */
export interface TrellisData {
  /** Logical trellis identifier — e.g. "auth-rewrite". */
  name: string;
  /** Resolved absolute path to the trellis file at plant time. Stable
   *  lookup even if the project's trellisDir changes later. */
  path: string;
  /** Iteration counter. Incremented on each working → reviewing
   *  transition before the budget check and dispatch. Reads as 1 during
   *  the first review, 2 during the second, etc. Starts at 0. */
  iteration?: number;
  maxIterations?: number;
  lastVerdict?: TrellisVerdict;
  lastDrift?: string[];
  alignedCount?: number;
  /** Bounded (length 5) history of drift lists for stagnation detection (v1.5). */
  driftHistory?: string[][];
  /** Bounded (length 5) history of HEAD SHAs at iteration boundaries (v1.5). */
  shaHistory?: string[];
  /** Epoch ms when stagnation was detected; cleared on next push (v1.5). */
  stagnationConfirmedAt?: number;
  /** Cited clauses from a FLAGGED verdict — used in the alert and the
   *  resume command's diagnostic output. */
  flaggedClauses?: string[];
  /** True when the terminal `done` was reached via reviewer ALIGNED
   *  rather than operator-set `.garden-done`. Drives the `✓ aligned,
   *  N iters` status row decoration. Set by finalizeMerge on the
   *  ALIGNED path. */
  aligned?: boolean;
  /** Epoch ms of the most recent Sonnet → Opus fallback. Used to
   *  dedupe alerts within a single Sonnet 5h reset window (phase 3). */
  modelFallbackAt?: number;
  /** Per-worker model override, set via `--model` at plant time. Read
   *  each iteration; falls back to WorkflowDefinition.workerModel,
   *  then project default. Trellis-only — default/grow workers carry
   *  the flat `WorkerEntry.model` instead. Opaque string: Anthropic
   *  aliases or any concrete model id the backend accepts. */
  workerModel?: string;
}

/** Grow-workflow per-worker data. The seed prompt is captured at plant
 *  time and inlined verbatim into every iter ≥ 2 continue prompt — that's
 *  why it lives on the entry rather than only on disk in a one-shot file.
 *  iteration is incremented on each working → reviewing transition (same
 *  pattern as TrellisData.iteration); maxIterations bounds the loop and
 *  is enforced at the post-merge auto-continue dispatch site (not at
 *  preflight, unlike trellis). */
export interface GrowData {
  /** Operator-supplied task description from `--seed` / `--seed-file` /
   *  picker prompt. Inlined verbatim into iter ≥ 2 continue prompts so
   *  the goal anchors across context resets. */
  seed: string;
  /** Iteration counter. Incremented on each working → reviewing transition
   *  before dispatch. Reads as 1 during the first review, 2 during the
   *  second, etc. Starts at 0. */
  iteration?: number;
  maxIterations?: number;
}

export interface WorkerRegistry {
  workers: Record<string, WorkerEntry[]>;
}

// ---------------------------------------------------------------------------
// Worker ordering: recency, attention tiers, staleness
// ---------------------------------------------------------------------------

// A worker's liveness timestamp (epoch ms): the most recent of "a Claude hook
// fired" (lastEventAt — bumped by every hook including the 10s heartbeat) and
// "the worker was created" (createdAt, the floor before its first hook). This
// is the heartbeat signal — it answers "did anything touch this worker
// recently" — and so it drives the 24h stale-dim threshold (isWorkerStale),
// NOT row ordering. Ordering uses workerSortFreshness; see its note.
export function workerFreshness(entry: WorkerEntry): number {
  return entry.lastEventAt ?? entry.createdAt ?? 0;
}

// A worker's ordering timestamp (epoch ms): the most recent meaningful state
// change (lastStateChangeAt — an agentStatus/prState transition), falling back
// to the heartbeat then createdAt for entries that predate the field. Used by
// compareWorkerFreshness so rows reshuffle ONLY when a worker genuinely moves.
// Deliberately not lastEventAt: the heartbeat bumps lastEventAt every 10s for a
// working agent without repainting the status pane (the refresh is gated on a
// real state change — see applyAndLog), so ordering by lastEventAt lets the
// registry order drift silently and then snap on the next unrelated repaint
// (e.g. the operator navigating to another worker). Keying on the
// state-change time keeps every reorder coincident with the repaint that the
// same transition already triggers.
export function workerSortFreshness(entry: WorkerEntry): number {
  return entry.lastStateChangeAt ?? entry.lastEventAt ?? entry.createdAt ?? 0;
}

// Attention tier for sort ordering — lower sorts higher on screen. Computed
// from raw agentStatus + prState (not the resolved display status) so this
// stays free of any commands/ dependency. The bands follow a worker's life
// from top to bottom: things that need you sit at the top, then the work
// descends through active → in-flight → done as it heads toward merge.
// Predicates are checked top-down, first match wins:
//   0  needs you      — blocked on the operator (failing / asking)
//   1  new            — launched, awaiting its first prompt (loading / ready)
//   2  active/recent  — working / idle / paused / exited; ordered by freshness,
//                       dims when stale (paused excepted — see isWorkerStale)
//   3  in flight      — the poller is driving it (reviewing → merging → merged),
//                       below active because it is descending toward done
//   4  done           — terminal, sinks to the bottom as a cleanup candidate
// The in-flight prState is checked before the new (loading/ready) agentStatus so
// a worker whose turn ended and was picked up for review is classified in-flight
// even if its agentStatus is a stale ready/loading (STATUS.md invariant).
//
// The active/recent band's tier number is named because isWorkerStale keys the
// stale-dim on it — a renumber must move both together or the wrong band dims.
export const ACTIVE_SORT_TIER = 2;
export function workerSortTier(entry: WorkerEntry): number {
  const pr = entry.prState;
  if (pr === "failing" || entry.agentStatus === "asking") return 0;
  if (pr === "done") return 4;
  if (pr === "reviewing" || pr === "resolving" || pr === "ci-fixing"
      || pr === "merge-pending" || pr === "merged") return 3;
  if (entry.agentStatus === "loading" || entry.agentStatus === "ready") return 1;
  return ACTIVE_SORT_TIER;
}

// Freshness is compared at 60-second granularity so a burst of state changes
// among co-active workers produces no reshuffling (the list stays calm); a
// worker quiet for over a minute still floats up promptly relative to one
// active now. This bucket plus keying on the state-change time (not the
// heartbeat — see workerSortFreshness) is what keeps the pane still.
const FRESHNESS_BUCKET_MS = 60_000;

// Sort comparator (use with Array.sort): attention tier ascending, then
// freshness descending (bucketed), then name as a stable tiebreak. Most
// attention-worthy workers rise to the top; alphabetical only breaks ties.
export function compareWorkerFreshness(a: WorkerEntry, b: WorkerEntry): number {
  const tierDiff = workerSortTier(a) - workerSortTier(b);
  if (tierDiff !== 0) return tierDiff;
  const bucketDiff =
    Math.floor(workerSortFreshness(b) / FRESHNESS_BUCKET_MS)
    - Math.floor(workerSortFreshness(a) / FRESHNESS_BUCKET_MS);
  if (bucketDiff !== 0) return bucketDiff;
  return a.name.localeCompare(b.name);
}

// A worker is "stale to the operator's eye" when nothing has touched it in a
// day. Deliberately far coarser than the 15-min STALE_* health constants
// (health.ts), which mean "Claude looks hung and the poller should act"; this
// only drives a dimmed status row. Staleness applies to the active/recent band
// only — blocked, new, in-flight, and done rows are never dimmed. The one
// active-band state that is also never dimmed is `paused`: an explicit operator
// hold rendered in bold cyan, where a dim would both fight that color (bold
// overrides faint) and hide a deliberate state the operator means to return to.
// Excluding it also keeps dimRow's invariant true — every row it dims is left
// uncolored by colorizeRow.
export const WORKER_STALE_MS = 24 * 60 * 60 * 1000;

export function isWorkerStale(entry: WorkerEntry, now: number = Date.now()): boolean {
  if (workerSortTier(entry) !== ACTIVE_SORT_TIER) return false;
  if (entry.agentStatus === "paused") return false;
  return now - workerFreshness(entry) > WORKER_STALE_MS;
}

// The authoritative agentStatus for a worker being restored via `claude
// --resume` (dashboard rebuild or bounce). SessionStart fires on --resume with
// source="resume", but the hook now PRESERVES whatever the resume dispatcher
// writes (see hooks/default.ts onSessionStart) instead of resetting it — so the
// value returned here is durable. Per STATUS.md a worker that has already
// received input never returns to the one-time "ready" state, with a single
// exception: an interrupted worker is parked at the "ready" cold-start sentinel
// that the auto-continue retry (continueWorkerIfStuck) watches to detect a
// re-prompt paste that never landed — returning "ready" here is also the signal
// the caller uses to dispatch that continue. An operator hold (`paused`) or a
// pending question (`asking`) survives the restart; every other worker returns
// to `idle` at the prompt (never the "new"-band "ready" that stranded resumed
// idle/done workers).
//
// The hold/question check comes FIRST, ahead of the interrupt check: an owed
// `interruptedWhileWorking` flag can linger on a worker the operator then held
// (holdWorker doesn't clear it; the deferred continue skips a paused worker
// without clearing it either). Resolving that combination to "ready" would let a
// bounce/rebuild dispatch an auto-continue that silently defeats the hold, so the
// operator's explicit, most-recent signal wins over the stale interrupt flag.
export function resolveResumeAgentStatus(
  entry: Pick<WorkerEntry, "agentStatus" | "interruptedWhileWorking">,
): AgentStatus {
  if (entry.agentStatus === "paused" || entry.agentStatus === "asking") {
    return entry.agentStatus;
  }
  if (entry.interruptedWhileWorking === true || entry.agentStatus === "working") {
    return "ready";
  }
  return "idle";
}

export const REGISTRY_FILE = path.join(SESSIONS_DIR, "dashboard.registry.json");
const LOCK_FILE = REGISTRY_FILE + ".lock";

// Serialize read-modify-write cycles via withFileLock. Throws on timeout —
// callers treat that as best-effort and proceed without the lock (a missed
// hook write is preferable to hanging the dashboard, but the helper logs
// at warn so the operator sees real contention).
function withRegistryLock<T>(fn: () => T): T {
  return withFileLock(LOCK_FILE, fn, { name: "registry" });
}

// Shape guard for parsed registry. Top-level must be an object with a
// `workers` field that maps project names to arrays. Per-entry validation
// requires `name` to be a string and type-checks GUARDED_STRING_FIELDS when
// present; every other WorkerEntry field is optional and untyped here, and
// absence is always legal (legacy entries from earlier garden versions don't
// carry baseBranch, workflow, etc.). A failed check signals hand-edit
// corruption, a forged entry, or a half-write that escaped atomic-rename;
// fall back to empty rather than feed junk into the poller.
//
// The guarded fields are the ones consumed WITHOUT re-validation to build
// filesystem paths (worktreePath), git targets (baseBranch/branchName), resume
// identity (sessionId), and lifecycle dispatch (prState/agentStatus). The
// registry lives in a sandbox-writable dir, so a forged wrong-typed value
// would otherwise flow straight into those consumers. Type is checked only
// WHEN PRESENT — the readRegistry migrations backfill several of these AFTER
// this guard runs, so a presence requirement would quarantine valid old
// registries.
const GUARDED_STRING_FIELDS = [
  "prState", "agentStatus", "baseBranch", "branchName", "worktreePath", "sessionId",
] as const;

function isWorkerRegistry(x: unknown): x is WorkerRegistry {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (!r.workers || typeof r.workers !== "object" || Array.isArray(r.workers)) return false;
  for (const entries of Object.values(r.workers as Record<string, unknown>)) {
    if (!Array.isArray(entries)) return false;
    for (const e of entries) {
      if (!e || typeof e !== "object") return false;
      const entry = e as Record<string, unknown>;
      if (typeof entry.name !== "string") return false;
      for (const field of GUARDED_STRING_FIELDS) {
        if (entry[field] !== undefined && typeof entry[field] !== "string") return false;
      }
      if (entry.ciNoRuns !== undefined) {
        if (!entry.ciNoRuns || typeof entry.ciNoRuns !== "object") return false;
        const stamp = entry.ciNoRuns as Record<string, unknown>;
        if (typeof stamp.sha !== "string" || typeof stamp.since !== "number") return false;
      }
    }
  }
  return true;
}

// In-process cache: registry parses are surprisingly hot. The hook dispatcher
// reads the registry on every Claude tool-use, the poller's tick reads it
// once per project, and refreshDashboard threads it through downstream calls
// — but per-hook the same shape is parsed multiple times because not every
// callsite participates in the RefreshOptions threading. Caching the parsed
// value keyed on file stat (mtimeMs+size) lets us skip the read+parse+migrate
// walk when nothing has changed on disk. Cross-process visibility is
// preserved: any external write changes mtime, so the next read sees fresh
// content. Returns a deep clone so callers can mutate freely (the existing
// read-modify-writeRegistry pattern relies on that).
let cachedRegistry: { mtimeMs: number; size: number; value: WorkerRegistry } | null = null;

function invalidateRegistryCache(): void {
  cachedRegistry = null;
}

// Marks an empty registry returned by readRegistry as unsafe to persist. It is
// set only when a *transient* read fault (a non-ENOENT IO error — EACCES,
// EMFILE, a busy fd) prevented reading a file that is still intact on disk.
// writeRegistry refuses to overwrite the file with such a result, because the
// next addWorker would otherwise erase every worker record permanently (the
// single worst-case data-loss vector). A genuinely-corrupt file is handled
// separately (quarantined below), so its empty fallback is NOT tainted — the
// bad bytes have been moved aside and a fresh start is the honest recovery.
const REGISTRY_TAINT = Symbol("registryReadFailed");

function taintedEmpty(): WorkerRegistry {
  const empty: WorkerRegistry = { workers: {} };
  Object.defineProperty(empty, REGISTRY_TAINT, { value: true, enumerable: false });
  return empty;
}

function isTaintedRegistry(registry: WorkerRegistry): boolean {
  return (registry as unknown as Record<PropertyKey, unknown>)[REGISTRY_TAINT] === true;
}

// Move a corrupt registry aside for forensics instead of letting the empty
// fallback silently overwrite it, and alert the operator that the fleet was
// reloaded empty. Best-effort: if the rename fails the next writeRegistry
// overwrites the corrupt file (the pre-existing behavior), which is no worse
// than before. The returned empty registry is deliberately NOT tainted — the
// bad file is gone, so a fresh addWorker legitimately recreates it.
function quarantineCorruptRegistry(reason: string): void {
  const dest = `${REGISTRY_FILE}.corrupt-${Date.now()}`;
  let moved = false;
  try {
    fs.renameSync(REGISTRY_FILE, dest);
    moved = true;
  } catch { /* best-effort — leave the file for writeRegistry to overwrite */ }
  log.error("registry", "registry file corrupt, reloading empty", {
    data: { reason, quarantine: moved ? dest : "(rename failed)" },
  });
  addAlert({
    level: "error",
    source: "registry",
    // Not tied to a single project — the registry spans the whole fleet. A
    // non-empty label keeps `garden alerts` from rendering a bare ": <msg>".
    project: "(all)",
    message:
      `Registry file was corrupt${moved ? ` and moved to ${path.basename(dest)}` : ""}. ` +
      `Workers were reloaded from an empty registry and may need re-adopting. ` +
      `The corrupt file is preserved for recovery.`,
    // Stable key: one alert per corruption event, not per re-read.
    dedupKey: "registry-corrupt",
  });
}

export function readRegistry(): WorkerRegistry {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(REGISTRY_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No registry yet (fresh install). Writable empty: the first addWorker
      // legitimately creates the file.
      return { workers: {} };
    }
    // The file exists but stat failed (permissions/IO). Taint so a write can't
    // clobber the intact-but-unreadable file with empty.
    log.warn("registry", "failed to stat registry, using tainted empty", {
      data: { error: String(err) },
    });
    return taintedEmpty();
  }

  if (cachedRegistry
      && cachedRegistry.mtimeMs === stat.mtimeMs
      && cachedRegistry.size === stat.size) {
    return structuredClone(cachedRegistry.value);
  }

  let contents: string;
  try {
    contents = fs.readFileSync(REGISTRY_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Deleted between stat and read — treat as fresh (writable empty).
      return { workers: {} };
    }
    // Transient IO error: file intact, momentarily unreadable. Taint the empty
    // fallback so writeRegistry refuses to persist it.
    log.warn("registry", "failed to read registry, using tainted empty", {
      data: { error: String(err) },
    });
    return taintedEmpty();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (err) {
    // Corrupt JSON (hand-edit, or a half-write that escaped atomic-rename).
    quarantineCorruptRegistry(`parse error: ${String(err)}`);
    return { workers: {} };
  }

  if (!isWorkerRegistry(raw)) {
    quarantineCorruptRegistry(
      `shape check failed (top-level keys: ${Object.keys(raw ?? {}).join(",")})`,
    );
    return { workers: {} };
  }

  // Lazily migrate legacy flat trellis* fields to the nested entry.trellis
  // sub-object. Idempotent: entries already in the new shape pass through
  // unchanged. The next writeRegistry persists the new shape; readers below
  // this layer never see the old flat keys.
  for (const entries of Object.values(raw.workers)) {
    for (const e of entries as WorkerEntry[]) {
      migrateLegacyTrellisFields(e);
      migrateLegacyStatusFields(e);
      migrateCreatedAt(e);
      migrateLastStateChangeAt(e);
    }
  }
  cachedRegistry = { mtimeMs: stat.mtimeMs, size: stat.size, value: raw };
  return structuredClone(raw);
}

const LEGACY_TRELLIS_KEYS = [
  "trellisName", "trellisPath", "trellisIteration", "trellisMaxIterations",
  "trellisLastVerdict", "trellisLastDrift", "trellisAlignedCount",
  "trellisDriftHistory", "trellisShaHistory", "trellisStagnationConfirmedAt",
  "trellisFlaggedClauses", "trellisAligned", "trellisModelFallbackAt",
  "workerModel",
] as const;

function migrateLegacyTrellisFields(entry: WorkerEntry): void {
  const e = entry as unknown as Record<string, unknown>;
  // Only migrate when the entry has at least the load-bearing trellisName
  // legacy field and no nested `trellis` sub-object yet. workerModel was
  // shared by trellis-only call sites so it migrates with the rest.
  if (typeof e.trellisName !== "string") return;
  if (entry.trellis !== undefined) {
    // Both shapes present — strip the legacy fields. The nested form wins.
    for (const k of LEGACY_TRELLIS_KEYS) delete e[k];
    return;
  }
  entry.trellis = {
    name: e.trellisName as string,
    path: typeof e.trellisPath === "string" ? e.trellisPath : "",
    iteration: e.trellisIteration as number | undefined,
    maxIterations: e.trellisMaxIterations as number | undefined,
    lastVerdict: e.trellisLastVerdict as TrellisVerdict | undefined,
    lastDrift: e.trellisLastDrift as string[] | undefined,
    alignedCount: e.trellisAlignedCount as number | undefined,
    driftHistory: e.trellisDriftHistory as string[][] | undefined,
    shaHistory: e.trellisShaHistory as string[] | undefined,
    stagnationConfirmedAt: e.trellisStagnationConfirmedAt as number | undefined,
    flaggedClauses: e.trellisFlaggedClauses as string[] | undefined,
    aligned: e.trellisAligned as boolean | undefined,
    modelFallbackAt: e.trellisModelFallbackAt as number | undefined,
    workerModel: e.workerModel as string | undefined,
  };
  for (const k of LEGACY_TRELLIS_KEYS) delete e[k];
}

// Lazily migrate the pre-multi-model status field names: claudeStatus →
// agentStatus, lastHookAt → lastEventAt (docs/MULTI-MODEL.md "Layer 2").
// Idempotent: migrated entries pass through untouched, and when both names
// are somehow present the new name wins. The next writeRegistry persists
// the new shape, exactly like the trellis migration above.
function migrateLegacyStatusFields(entry: WorkerEntry): void {
  const e = entry as unknown as Record<string, unknown>;
  if (e.claudeStatus !== undefined) {
    if (entry.agentStatus === undefined) entry.agentStatus = e.claudeStatus as AgentStatus;
    delete e.claudeStatus;
  }
  if (e.lastHookAt !== undefined) {
    if (entry.lastEventAt === undefined) entry.lastEventAt = e.lastHookAt as number;
    delete e.lastHookAt;
  }
}

// Backfill createdAt (the worker's birth timestamp, used for recency ordering)
// on entries that predate the field. In-memory only — readRegistry is hot, so
// no statSync. Prefer the freshness signal already on the entry, then the ISO
// transition timestamps, else 0 (a genuinely inactive entry that correctly
// sinks + dims; its next hook self-heals it via lastEventAt). Must run after
// migrateLegacyStatusFields so it observes the migrated lastEventAt. Idempotent
// and persisted on the next writeRegistry, like the migrations above.
function migrateCreatedAt(entry: WorkerEntry): void {
  if (entry.createdAt !== undefined) return;
  const isoMs = (s?: string): number | undefined => {
    if (!s) return undefined;
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : t;
  };
  entry.createdAt =
    entry.lastEventAt ?? isoMs(entry.mergedAt) ?? isoMs(entry.lastShaChangeAt) ?? 0;
}

// Backfill lastStateChangeAt (the row-ordering timestamp) on entries that
// predate the field. Seed it from the heartbeat (lastEventAt) so an entry's
// order is unchanged at upgrade time, then freezes there — closing the drift
// window for a worker mid-turn at upgrade instead of waiting for its next
// transition. createdAt is the floor (migrateCreatedAt runs first). In-memory
// only, persisted on the next writeRegistry, like the migrations above.
function migrateLastStateChangeAt(entry: WorkerEntry): void {
  if (entry.lastStateChangeAt !== undefined) return;
  entry.lastStateChangeAt = entry.lastEventAt ?? entry.createdAt ?? 0;
}

const MAX_REGISTRY_BACKUPS = 5;

function countWorkers(reg: WorkerRegistry): number {
  let n = 0;
  for (const entries of Object.values(reg.workers)) n += entries.length;
  return n;
}

// Snapshot the current registry before a write that reduces the total worker
// count. Mass shrinkage — a bug, a bad hand-edit, or removeWorker acting on a
// stale read — is the one write shape that can lose worker records the
// read-time guards don't catch, so a rotating backup makes it recoverable.
// oldCount comes from the cached pre-mutation registry the caller just read
// under the lock (readRegistry populates it, then returns a clone the caller
// mutates), so the no-shrink hot path — every field/heartbeat update from the
// hook firehose — compares two in-memory counts and returns without touching
// disk. The cache is populated exactly when there is a file worth protecting:
// the ENOENT/quarantine paths leave it null (nothing on disk to snapshot) and
// the taint/stat-fail paths make writeRegistry return before reaching here.
// Best-effort throughout.
function backupOnShrink(next: WorkerRegistry): void {
  const current = cachedRegistry?.value;
  if (!current) return; // no cached pre-write state -> nothing on disk to protect
  const oldCount = countWorkers(current);
  if (oldCount === 0 || countWorkers(next) >= oldCount) return;
  // Confirmed shrink: read the actual on-disk bytes (not the cached value) so
  // the backup is a faithful copy of what is about to be overwritten.
  try {
    const currentRaw = fs.readFileSync(REGISTRY_FILE, "utf-8");
    fs.writeFileSync(`${REGISTRY_FILE}.bak-${Date.now()}`, currentRaw);
    const dir = path.dirname(REGISTRY_FILE);
    const prefix = `${path.basename(REGISTRY_FILE)}.bak-`;
    const backups = fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_REGISTRY_BACKUPS))) {
      try { fs.unlinkSync(path.join(dir, stale)); } catch { /* ignore */ }
    }
  } catch { /* best-effort */ }
}

export function writeRegistry(registry: WorkerRegistry): void {
  if (isTaintedRegistry(registry)) {
    // This registry descends from a failed read of an intact file. Persisting
    // it would erase every worker record. Refuse and preserve the on-disk
    // file; the transient fault self-heals and the next mutation reads real
    // state. The mutation that produced this write is silently dropped — a lost
    // field update recovers on the next event; a lost addWorker is caught by
    // the create flow noticing the missing entry.
    log.error("registry", "refusing to persist registry built from a failed read", {});
    return;
  }
  backupOnShrink(registry);
  atomicWriteFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  // Invalidate after write so the next readRegistry picks up fresh state.
  // mtime would change anyway, but explicit invalidation guards against
  // sub-millisecond mtime resolution on some filesystems clamping the
  // post-write mtime to the same value as a pre-write read.
  invalidateRegistryCache();
}

// Locked whole-registry read-modify-write for callers outside this module that
// need to mutate more than a single worker's fields (e.g. the validator's ghost
// sweep and its mark-exited pass). `withRegistryLock` is module-private on
// purpose — this is the one blessed way to run a caller-defined registry
// mutation under the same lock every built-in mutator holds. `fn` receives a
// freshly-read (under the lock) registry, mutates it in place, and returns
// whether anything changed; the write happens iff it returns true. Callers must
// mutate only inside `fn`, never persist their own snapshot via writeRegistry —
// that is exactly the unlocked read-modify-write this replaces. The freshly
// read registry means concurrent writes to other workers' fields are never
// clobbered by a stale snapshot.
export function mutateRegistry(fn: (registry: WorkerRegistry) => boolean): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    if (fn(registry)) writeRegistry(registry);
  });
}

export function addWorker(project: string, entry: WorkerEntry): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    if (!registry.workers[project]) registry.workers[project] = [];
    registry.workers[project].push(entry);
    writeRegistry(registry);
  });
}

export function removeWorker(project: string, workerName: string): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entries = registry.workers[project];
    if (!entries) return;
    registry.workers[project] = entries.filter(e => e.name !== workerName);
    if (registry.workers[project].length === 0) delete registry.workers[project];
    writeRegistry(registry);
  });
}

export function updateWorkerTask(project: string, workerName: string, task: string): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entries = registry.workers[project];
    if (!entries) return;
    const entry = entries.find(e => e.name === workerName);
    if (!entry) return;
    entry.task = task;
    writeRegistry(registry);
  });
}

/** Field-update payload accepted by updateWorkerFields. Top-level fields
 *  are shallow-merged onto the entry. The nested `trellis` and `grow` fields
 *  are deep-merged into the existing sub-object — passing
 *  `{ trellis: { lastVerdict: "ALIGNED" } }` or `{ grow: { iteration: 3 } }`
 *  updates only that one field without clobbering the rest of the sub-object. */
export interface WorkerFieldsUpdate
  extends Partial<Omit<WorkerEntry, "name" | "trellis" | "grow">> {
  trellis?: Partial<TrellisData>;
  grow?: Partial<GrowData>;
}

export function updateWorkerFields(
  project: string,
  workerName: string,
  fields: WorkerFieldsUpdate,
): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entries = registry.workers[project];
    if (!entries) return;
    const entry = entries.find(e => e.name === workerName);
    if (!entry) return;

    if (fields.prState && fields.prState !== entry.prState) {
      log.info("poller", `${entry.prState ?? "new"} -> ${fields.prState}`, {
        worker: workerName,
        data: { project },
      });
    }

    const { trellis: trellisUpdate, grow: growUpdate, ...rest } = fields;
    Object.assign(entry, rest);
    if (trellisUpdate !== undefined) {
      // Merge into existing trellis. If entry.trellis is unset (a default
      // worker received a stray trellis update — caller bug), the spread
      // still produces a TrellisData-shaped object from whatever was passed.
      entry.trellis = { ...(entry.trellis ?? {}), ...trellisUpdate } as TrellisData;
    }
    if (growUpdate !== undefined) {
      // Same deep-merge pattern as trellis. Caller bug if entry.grow is
      // unset and the update lacks `seed`; the resulting object would have
      // no anchoring seed for iter ≥ 2 prompts. The cast lets the broken
      // shape persist (rather than throw) so the loop can surface it
      // visibly via a missing-seed iteration prompt.
      entry.grow = { ...(entry.grow ?? {}), ...growUpdate } as GrowData;
    }
    writeRegistry(registry);
  });
}

export function batchUpdateWorkerFields(
  updates: Array<{ project: string; workerName: string; fields: WorkerFieldsUpdate }>,
): void {
  if (updates.length === 0) return;
  withRegistryLock(() => {
    const registry = readRegistry();
    for (const { project, workerName, fields } of updates) {
      const entries = registry.workers[project];
      if (!entries) continue;
      const entry = entries.find(e => e.name === workerName);
      if (!entry) continue;
      if (fields.prState && fields.prState !== entry.prState) {
        log.info("poller", `${entry.prState ?? "new"} -> ${fields.prState}`, {
          worker: workerName,
          data: { project },
        });
      }
      const { trellis: trellisUpdate, grow: growUpdate, ...rest } = fields;
      Object.assign(entry, rest);
      if (trellisUpdate !== undefined) {
        entry.trellis = { ...(entry.trellis ?? {}), ...trellisUpdate } as TrellisData;
      }
      if (growUpdate !== undefined) {
        entry.grow = { ...(entry.grow ?? {}), ...growUpdate } as GrowData;
      }
    }
    writeRegistry(registry);
  });
}

export function findWorkerByName(
  project: string,
  workerName: string,
): WorkerEntry | undefined {
  return getWorkers(project).find(e => e.name === workerName);
}

export function getWorkers(project: string): WorkerEntry[] {
  return readRegistry().workers[project] ?? [];
}

export function getAllWorkerNames(): string[] {
  const registry = readRegistry();
  const names: string[] = [];
  for (const entries of Object.values(registry.workers)) {
    for (const entry of entries) {
      names.push(entry.name);
    }
  }
  return names;
}
