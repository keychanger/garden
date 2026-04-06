# Worker Status System

Spec for the worker status tracking and display system. This document is the
source of truth for how status works. If the code disagrees with this document,
the code is wrong.

## Display states

These are the states the user sees in the status pane. Nothing else is shown.

| State         | Icon | Meaning                                          |
|---------------|------|--------------------------------------------------|
| ready         | `*`  | Fresh worker. Claude loaded, waiting for first input. |
| working       | `@`  | Claude is actively processing. Coding, planning, answering — doesn't matter. |
| idle          | `#`  | Claude is at the prompt. Ball is in the user's court — waiting for input, permission, or has an answer to read. Not in the review cycle. |
| reviewing     | `%`  | Automated reviewer is checking the worker's code. |
| merge-pending | `&`  | Review passed. Queued for merge.                 |
| merged        | `+`  | Code landed on the base branch.                  |
| failing       | `x`  | Review failed. Waiting for worker to fix.        |
| exited        | `o`  | Worker process died.                             |

(Icons shown here are placeholders. Actual icons are Unicode symbols defined
in `status.ts`.)

## State transitions

```
  [ready] ---------> [working] --------> [idle]
                       ^  |                 |
                       |  |                 | (new input)
                       |  |                 |
       (new input)     |  | (new commits    |
       .---------------'  |  + Claude stops)|
       |                  |                 |
       |                  v                 |
       |              [reviewing] ------.   |
       |                  |             |   |
       |                  | (passed)    |   |
       |                  v             |   |
       |           [merge-pending] -----'   |
       |                  |          (rebase conflict)
       |                  | (merged)
       |                  v
       '------------- [merged] <------------'
                                  (no new commits;
                                   stays merged)

       Error path:
       [reviewing] ---> [failing] ---> [working] (new commits after debounce)
```

The two exits from `working` are the core branching point:
- **No new commits** -> `idle` (ball in user's court, not in review cycle)
- **New commits** -> `reviewing` (enters review cycle, skips idle entirely)

### Transition rules

**ready -> working**: Claude receives input (UserPromptSubmit hook fires).
One-time transition. A worker never returns to `ready`.

**working -> idle**: Claude finishes processing (Stop hook fires) and there
are no new commits ahead of the base branch (or no *new* commits since the
last merge). Claude is at the prompt — it answered a question, made a plan,
is waiting for permission, or otherwise finished without producing code.
The user probably has something to look at.

**working -> reviewing**: Claude finishes processing (Stop hook fires) and
there are new commits ahead of the base branch. The poller launches a
reviewer. This is the key gate: review only starts when Claude is done.
The worker skips `idle` entirely — it goes straight into the review cycle.

**idle -> working**: Claude receives new input (UserPromptSubmit hook fires).

**reviewing -> merge-pending**: Reviewer verdict is CLEAN or FIXED.

**reviewing -> failing**: Reviewer verdict is FAILED.

**reviewing -> working**: New commits appear on the worker branch while the
reviewer is running. Review is aborted because it's now stale. Returns to
`working` so the poller waits for Claude to finish before re-reviewing.

**merge-pending -> merged**: Fast-forward merge succeeds.

**merge-pending -> reviewing**: Rebase onto current base branch has
conflicts. A scoped re-review is launched to resolve them.

**merge-pending -> working**: Merge fails for non-conflict reasons. Alert
surfaced.

**failing -> working**: Worker pushes new commits after the debounce period
(30s). Back to the normal cycle.

**merged -> working**: Claude receives new input. Back to the cycle.

**From working, the two exits are always the same:**
- No new commits -> `idle` (ball in user's court)
- New commits -> `reviewing` (enters review cycle)

This is true regardless of whether the worker was previously merged, idle,
or fresh. The review cycle and idle are mutually exclusive outcomes of
working.

**Any state -> exited**: Worker pane process dies.

### What "pushed" is NOT

There is no `pushed` display state. Internally, the poller tracks that
commits exist ahead of the base branch. But from the user's perspective:

- If Claude is still working: show `working`.
- If Claude stopped and commits exist: show `reviewing` (the reviewer
  launches immediately when Claude stops).
- The brief window between "Claude stopped" and "reviewer launched" is
  sub-second and not user-visible.

If for some reason the reviewer can't launch immediately (e.g., poller
hasn't ticked yet), the worker stays in `working` until the next poll
cycle launches the reviewer. This gap is sub-second in practice.

## Key invariants

1. **`idle` and the review cycle are mutually exclusive.** If a worker is in
   the review cycle (reviewing, merge-pending, merged, failing), it never
   shows `idle`. If it shows `idle`, it's not in the review cycle.

2. **`working` is the only entry point to the review cycle.** The poller
   only transitions to `reviewing` when Claude stops working and new commits
   exist. You cannot go from `idle` directly to `reviewing`.

3. **`ready` is one-time.** Once a worker receives its first input, it
   never returns to `ready`.

4. **Lifecycle states are sticky.** A worker stays `merged` even if Claude
   is actively answering a question, until new commits appear. The lifecycle
   state tells the user where the *code* is, not what Claude is doing.

5. **`pushed` is never displayed.** It is an internal poller state. The
   user sees `working` (Claude still going) or the reviewer launches.

## Detection machinery

Status detection answers one question: **is Claude currently processing?**
Everything else is derived from that answer plus the poller's lifecycle
tracking.

### Signal sources (ordered by authority)

1. **Hooks** (highest authority): Claude Code fires `UserPromptSubmit` when
   processing starts and `Stop` when it finishes. These are the
   authoritative signals for working/idle transitions.

2. **Marker files**: The hooks write/delete a file at
   `~/.garden/sessions/claude-active-<project>-<worker>`. This persists the
   working/idle signal so that process detection can read it without
   re-querying hooks. The marker's mtime is touched whenever tool
   subprocesses are detected, so staleness measures "time since last
   activity" not "time since prompt."

3. **Child process detection** (pgrep): Detects whether Claude has active
   tool subprocesses. Used to confirm working state and to touch the marker
   mtime. Cannot detect in-process work (subagents, API calls), which is
   why the marker exists.

4. **Registry cache** (lowest authority): The `claudeStatus` field in the
   registry caches the last-known process status. Used by the quick render
   path for instant display. May be stale.

### Detection function

`detectPaneProcessStatus(paneId, project, worker)` returns a
`ProcessStatus`:

```
  pane PID exists?
    no  -> exited
    yes -> Claude child PID exists?
      no  -> has other children?
        yes -> loading
        no  -> ready
      yes -> has non-MCP child processes?
        yes -> working (touch marker)
        no  -> marker file fresh?
          yes -> working
          no  -> has activity text?
            yes -> idle
            no  -> ready
```

### Two render paths

**Full render** (`garden status` / `printHeader`): Calls
`detectPaneProcessStatus` for live process detection. Writes result to
registry `claudeStatus`. Accurate but costs a pgrep call per worker.

**Quick render** (`renderQuickStatus`): Reads `claudeStatus` from the
registry. No process detection. Used for instant visual feedback after
mutations (new worker, kill worker, project switch). The next full render
corrects any staleness.

### Display resolution

One function resolves display status from process status + lifecycle state:

```
resolveDisplayStatus(processStatus, lifecycleState) -> DisplayStatus:

  if lifecycleState is merged       -> merged
  if lifecycleState is merge-pending -> merge-pending
  if lifecycleState is reviewing    -> reviewing
  if lifecycleState is failing      -> failing

  // No lifecycle state, or lifecycle is "working"/"pushed" (internal):
  // fall through to process status
  return processStatus
```

The lifecycle states (reviewing, merge-pending, merged, failing) always
take priority because they represent pipeline stages that don't depend on
what Claude is doing right now. A merged worker is merged even if Claude is
actively answering a question — until new commits appear.

**`idle` only appears when there is no active lifecycle state.** A worker
in the review cycle (reviewing, merge-pending, merged, failing) never
shows idle, even if Claude is at the prompt. The lifecycle state is more
informative.

When lifecycle is `pushed` (internal-only, never displayed):
- Process is `working` -> show `working` (Claude still going)
- Process is not `working` -> show `working` until the reviewer launches
  (sub-second gap, next poll cycle picks it up)

### Hook -> display pipeline

The full signal flow from input to pixels:

```
  User sends message to Claude
    |
    v
  UserPromptSubmit hook fires
    |
    +---> write marker file
    +---> set registry claudeStatus = "working"
    +---> signal status pane (SIGUSR1)
    |
    v
  Status pane re-renders (quick path: reads registry)
    |
    v
  User sees: working (spinner)

  ... Claude processes ...

  Stop hook fires
    |
    +---> delete marker file
    +---> set registry claudeStatus = "idle"
    +---> signal status pane (SIGUSR1)
    |
    v
  Status pane re-renders (quick path: reads registry)
    |
    v
  User sees: idle

  ... Poller detects new commits, Claude is idle ...

  Poller launches reviewer
    |
    +---> set registry prState = "reviewing"
    +---> signal status pane
    |
    v
  User sees: reviewing
```

## Marker file lifecycle

The marker file bridges the gap between hooks (which fire at the right
time) and process detection (which runs on demand).

**Created**: On `UserPromptSubmit` hook. Written synchronously by
`handleClaudeHook("prompt")`.

**Touched**: By `detectPaneProcessStatus` whenever it finds active non-MCP
child processes. This keeps the mtime fresh so that the staleness check
measures "time since last tool activity" rather than "time since the user
sent a message."

**Deleted**: On `Stop` hook. Deleted synchronously by
`handleClaudeHook("stop")`.

**Stale expiry**: If the marker is older than `MARKER_STALE_MS` (2
minutes), `isClaudeActiveByHook` deletes it and returns false. This
handles the case where Claude crashes without firing the Stop hook.

The 2-minute threshold is a tradeoff: long enough to survive gaps between
tool calls (Claude thinking about what to do next), short enough to clear
stuck markers from crashes.

## Known edge cases

**Subagent work with no tool calls**: Claude can spend minutes on
in-process subagent work (API calls, planning) with no child processes.
The marker file keeps the status as "working" during this time. If the gap
exceeds 2 minutes without any tool subprocess, status will briefly flicker
to "idle" before the next tool call creates a child process and detection
switches back to "working." This is acceptable — a 2-minute gap with zero
activity is unusual.

**Reviewer launched while Claude was between keystrokes**: The poller
checks `isWorkerWorking()` before launching a review. If Claude happens to
be idle between rapid-fire messages, the poller might launch a review
prematurely. The review will be aborted if new commits appear during the
review.

**Multiple merges in one session**: The `mergeCount` in the registry
tracks how many times a worker has gone through the full cycle. Display
shows "merged (x3)" etc. Each cycle is independent.
