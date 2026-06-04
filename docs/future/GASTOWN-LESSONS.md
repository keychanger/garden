## Status

External-codebase analysis with proposed roadmap. Not a committed plan. Decisions
live with the operator; this document exists to surface concrete options and the
reasoning behind each verdict, so future garden work can pull from a clearer
shortlist instead of re-deriving the comparison every time gastown ships
something interesting.

This file lives under `docs/future/` — bead / `bd` / Dolt references
describe gastown, not garden. See `rules.md` § Specifications and
documentation.

Source: `gastownhall/gastown` @ `main`, surveyed 2026-05-09. Gastown is roughly
422K LOC across 1,139 Go files in 71 internal packages (`cmd/`, `internal/`,
`plugins/`, `gt-model-eval/`); garden is roughly 18K LOC across 93 TypeScript
files. The size delta is real, but most of gastown's surface area solves
problems garden does not yet have. The interesting question is not "should
garden be more like gastown" — it is "which of gastown's *primitives* would
pay off in garden's intentionally smaller frame."

# Lessons from Gas Town

## 1. Context

Gastown is a multi-agent orchestration tool by Steve Yegge (and contributors),
distributed as a Go binary `gt` with a sibling issue-tracker `bd` (beads). Its
operating mental model is a **town**: a workspace dir holding multiple **rigs**
(projects), with **polecats** (worker agents, persistent identity / ephemeral
sessions) running inside rigs. Persistent state lives in a per-town **Dolt SQL
server** (git-backed SQL via `bd`); coordination state lives in **beads**
(git-tracked structured issues). A persistent AI **Mayor** is the human's
primary interface ("tell the Mayor what you want to build"), and a **Deacon**
daemon plus per-rig **Witnesses** form a three-tier watchdog over polecat
health. A **Refinery** runs a Bors-style bisecting merge queue per rig.

Beyond the core, gastown ships a **scheduler** (capacity governor for
polecat dispatch), an **escalation** subsystem (severity-routed agent-to-human
chain), **convoys** (cross-rig batched work tracking units), **mail + nudge**
(persistent vs ephemeral inter-agent communication), **formulas + overlays**
(TOML workflow templates with town/rig override layers), a **plugin** system
(TOML-defined cron-gated maintenance tasks dispatched as Dogs), an OTLP
**telemetry** plane, multi-runtime **agent provider** support (Claude / Codex /
Copilot / Cursor / Gemini / Auggie / Amp / OpenCode / Pi / Omp), a TUI
**activity feed** with stuck-agent detection, an htmx **web dashboard**, and
**Wasteland** federation (cross-town work claiming via DoltHub). Several of
these are spec'd-but-not-implemented (notably the AT-team-lead Witness and the
exitbox/daytona sandbox), which is its own data point — gastown reasons in the
open about ideas, then ships incrementally.

### 1.1 Side-by-side mental model

| Concept | Gastown | Garden today |
|---|---|---|
| Workspace root | Town (`~/gt/`) with multiple rigs | Per-machine `~/.garden/` + N project checkouts |
| Project | Rig (managed clone + bare `.repo.git`) | Project (registered cwd, branched into worktrees) |
| Worker | Polecat (persistent identity, ephemeral session, in worktree) | Worker (persistent name + worktree, ephemeral tmux pane) |
| Coordinator | Mayor (AI, persistent session) + Deacon daemon | Operator (human) + per-project poller (event-driven Go-style runtime) |
| Watchdog | Witness (per-rig) → Deacon (cross-rig) → Boot (deacon's deacon) | `alerts.ts` + Stop hook + interrupt-recovery in `continue.ts` |
| Merge | Refinery (Bors-style bisecting queue) | `poller-merge.ts` (serial, per-branch, headless reviewer-gated) |
| Persistence | Dolt SQL (per-town) + beads (issue rows) | Atomic JSON files (`registry.json`, `state.json`, `alerts.json`) |
| Inter-agent comms | Mail (Dolt-persistent) + Nudge (tmux send-keys) | `kick` (paste prompt to pane) only |
| Capacity | Scheduler (`max_polecats`, deferred dispatch) | None — workers spawn on demand |
| Telemetry | OTLP (logs + metrics counters/histograms) | Tail-only structured logs (`townlog`-style filter, no metrics) |
| Workflow definitions | TOML formulas + per-town/per-rig overlays + role directive markdown | Hard-coded TS workflows (`default`, `trellis`, `grow`); per-project `.garden/rules.md` |
| Worker runtime | Multi (Claude, Codex, Copilot, Gemini, Cursor, Auggie, Amp, OpenCode, Pi, Omp) | Claude Code only |
| Sandbox | Local UID + spec'd exitbox + spec'd daytona (remote container w/ mTLS proxy) | Seatbelt (macOS) / bubblewrap (Linux) via `sandbox.ts` |
| Activity surface | `gt feed` 3-panel TUI + htmx web dashboard | Logs pane (filter-aware) + status pane |
| Issue tracker | Built in (beads, Dolt-backed) | None (issues are conversation context) |
| Federation | Wasteland (DoltHub-mediated work claiming) | None (intentional) |

### 1.2 Where the systems disagree by design

Garden's intentional minimalism is its own design feature, not a gap. Several
gastown choices clearly do *not* fit garden, regardless of pull:

- **Single operator, no team.** Gastown's Mayor → Deacon → Mayor → Overseer
  escalation chain assumes multiple stakeholders. Garden has one.
- **Owned foundation.** Gastown depends on Dolt as a SQL server, beads as an
  issue ledger, and a custom Go daemon. The `feedback_top_of_stack_dependencies`
  memory is explicit: garden is wary of external tech at the orchestration
  layer. Adopting Dolt would invert that posture.
- **Snappiness over completeness.** Garden prefers event-driven (Stop-hook
  poller, FIFO-based dispatch) over heartbeat polling. Gastown's daemon ticks
  every 3 minutes — fine for cross-machine federation, wrong for a tmux
  dashboard the user is staring at.
- **Operator drives the work.** Garden's UX is "human types a command;
  workflow runs to completion." The Mayor pattern inverts that ("human
  describes intent; coordinator dispatches workers"). The trellis and grow
  workflows are garden's "task → loop" abstraction; an AI Mayor is a
  qualitatively different bet.

The lessons below filter through these constraints. "Skip" verdicts are not
a judgment of gastown — they are recognitions that garden has chosen the
opposite trade-off, deliberately.

## 2. Lessons

Each lesson is keyed by a short heading, then states what gastown does, what
garden does today, the lift to adopt some form of it in garden, the impact if
adopted, and a verdict. Lift and impact are coarse buckets (low / medium /
high). The verdict is one of:

- **Adopt** — clear win, take the idea
- **Adapt** — take the shape, not the implementation
- **Defer** — promising, but no concrete pull yet
- **Skip** — design conflict or insufficient impact

### Theme A — Operator visibility and worker health

#### A1. Stuck-agent classification

- **Gastown.** `internal/witness/manager.go` + `internal/deacon/stuck.go`
  expose a multi-state agent health model. Display states include `working`,
  `idle`, `stalled` (hooked work with reduced progress), `GUPP violation`
  (hooked work with no progress for an extended window), and `zombie` (dead
  tmux session). The `gt feed --problems` view groups agents by health state
  and exposes intervention keys: `n` to nudge, `h` to handoff. Detection
  parameters are configurable (`PingTimeout = 30s`,
  `ConsecutiveFailures = 3`, `Cooldown = 5min`).
- **Garden today.** `registry.ts` carries `agentStatus` ∈ {loading, ready,
  working, asking, idle, exited}. Hooks write the value, `pane-died` writes
  `exited`. There is no `stalled` state — a worker that's been "working" for
  2 hours with no diff shows the same indicator as one that's actively
  committing.
- **Lift.** Medium. Add a derived `stalled` predicate in `registry.ts` keyed
  on `(agentStatus === "working") && (now - lastActivityTs > threshold)`,
  surface it in `header.ts` / `status.ts`, and (optionally) auto-emit an alert
  via `addAlert`. Wire `lastActivityTs` from the existing pane-output stream
  in `usage-poller.ts` or hook events.
- **Impact.** High. Stuck workers are real, and operator load to spot them
  visually scales with worker count. Even at 2-3 workers, "did Claude actually
  start working or is it sitting in a planning monologue" is a question the
  operator asks routinely.
- **Verdict.** Adopt — proportionate. Skip the Witness / Deacon / Boot
  hierarchy. A single derived `stalled` state plus an alert with
  configurable threshold matches garden's frame.

#### A2. Escalation as a first-class verb

- **Gastown.** `gt escalate -s {MEDIUM,HIGH,CRITICAL} "<msg>"` creates an
  escalation bead, multi-channels via configured routes (mail / email / SMS /
  Slack), and is re-escalated on staleness with severity bumps. Workers are
  trained to `gt escalate` rather than fail silently. Severity routes through
  Deacon → Mayor → Overseer.
- **Garden today.** Workers can't escalate explicitly. The closest signal is
  the headless reviewer flagging a problem into `alerts.ts`, but workers
  themselves have no verb. They either keep grinding or end their turn
  silently.
- **Lift.** Low. A `garden escalate <severity> "<msg>"` command that writes to
  `alerts.ts` with a stable dedup key, plus a worker-prompt line teaching
  workers when to call it (the gastown mail-protocol's "when to escalate"
  list is a good template). Skip the Deacon → Mayor → Overseer routing —
  garden's audience is the operator.
- **Impact.** Medium. It cleanly separates "I am stuck and need help" from
  "I failed review," which today look identical in the alerts ribbon. It also
  gives the trellis/grow workflows a clean exit verb for "the goal is
  unsolvable as specified."
- **Verdict.** Adopt.

#### A3. Structured event stream + metrics

- **Gastown.** Full OTLP. Counters: `gastown.session.starts.total`,
  `gastown.polecat.spawns.total`, `gastown.done.total`,
  `gastown.sling.dispatches.total`, etc. Histogram:
  `gastown.bd.duration_ms`. Resource attrs propagate `gt.run_id` for
  cross-process correlation. Backend-agnostic (defaults to
  VictoriaMetrics/Logs but speaks any OTLP backend).
- **Garden today.** Tail-only logs via `townlog`-style writer. Filter syntax
  for `worker:`, `src:`, `level:`, `project:`. No metrics. No correlation IDs
  spanning poller / worker / reviewer / resolver.
- **Lift.** Medium. Two-step: (1) emit structured JSONL events at well-defined
  boundaries (worker spawn, review start/end, merge attempt/result, hook
  fire, auto-continue trigger) with a `runId` correlation key; (2) a
  `garden stats` command that aggregates the JSONL into counts and
  durations. OTLP is a later swap once the events exist.
- **Impact.** High. Concrete questions garden cannot answer today: average
  trellis iteration count to merge, % of reviews that pass first attempt,
  median worker idle-after-spawn time, daily quota burn rate by project.
  These are operator-actionable; the user has expressed production-rigor
  expectations.
- **Verdict.** Adopt. Start local-only (JSONL + `garden stats`); migrate to
  OTLP when there's a backend the user actually runs.

#### A4. Activity feed (problems-first surface)

- **Gastown.** `gt feed` is a three-panel TUI: agent tree (grouped by rig and
  role), convoy panel (in-progress and recently-landed convoys), event
  stream (chronological). `gt feed --problems` toggles to a health-state
  grouping. Curator daemon (`internal/feed/curator.go`) deduplicates
  ("5 molecule updates → 1 'agent active'") and aggregates ("3 issues closed
  → 'batch complete'") before writing `~/gt/.feed.jsonl`.
- **Garden today.** Single logs pane with sticky filter. The pane is
  chronological raw output — no dedup, no aggregation, no health grouping.
- **Lift.** Medium, gated on A3 (needs structured events first). Once events
  exist, a curator that produces a derived feed file plus a problems-mode
  filter on the existing logs pane is incremental.
- **Impact.** Medium-high once worker count reaches the visual-scan limit
  (~4-5 panes).
- **Verdict.** Defer until A3 ships, then adopt incrementally.

### Theme B — Capacity, throughput, and merge

#### B1. Capacity governor for worker dispatch

- **Gastown.** `scheduler.max_polecats` config gates concurrent polecats;
  `gt sling` switches between direct and deferred dispatch automatically.
  Sling-context beads track scheduled-but-not-dispatched work; the daemon's
  step-14 heartbeat dispatches incrementally up to capacity. A circuit
  breaker closes the context after 3 dispatch failures.
- **Garden today.** None. `garden workers new` spawns immediately. The
  `handoff` skill fan-outs to N workers in parallel; nothing prevents the
  user from spawning 8 workers across 3 projects and watching their Claude
  quota disappear in 20 minutes.
- **Lift.** Medium. A `maxConcurrentWorkers` config (per-machine and/or
  per-project) plus a queue file plus a tick from the existing per-project
  poller. Deferred dispatch starts simple — FIFO, no priorities. Skip the
  beads-context indirection (garden's queue can live in a JSON file).
- **Impact.** High the moment fan-out is used in anger. Without it, the user
  is one mistake away from quota exhaustion and the existing usage poller
  only *reports* the damage, doesn't prevent it.
- **Verdict.** Adopt. Tie into `usage.ts` so the governor can also pause on
  quota warning thresholds, not just count-based capacity.

#### B2. Bors-style bisecting merge queue

- **Gastown.** Refinery (`internal/refinery/engineer.go`, ~2150 LOC):
  batches pending MRs, rebases as a stack on main, runs gates on the stack
  tip; on green, fast-forwards all; on red, bisects the midpoint. Pluggable
  gates (test, lint), batch-and-bisect strategy is core.
- **Garden today.** `poller-merge.ts` (~177 LOC) merges serially, one branch
  at a time, gated on per-branch headless review.
- **Lift.** High. Garden's per-branch headless review is intentional and
  load-bearing — each PR gets a careful AI review, not just a test gate.
  Batching loses per-branch verdicts unless reviewers also run in parallel
  before batching, which complicates the failure model.
- **Impact.** Low at current scale. Merge throughput is not the bottleneck
  when 1-3 workers complete per day.
- **Verdict.** Skip. Reconsider only if a multi-worker fan-out pattern
  routinely produces 5+ simultaneously-mergeable branches into the same base.

### Theme C — Worker primitives

#### C1. Mail vs Nudge (persistent vs ephemeral comms)

- **Gastown.** Two channels with strict guidance. Nudge (`gt nudge`) is
  tmux send-keys to a live pane — zero storage cost, lost on session death,
  used for routine pings. Mail (`gt mail`) creates a Dolt-persistent message
  bead — survives session death, used for protocol messages
  (POLECAT_DONE, MERGE_READY, REWORK_REQUEST, HANDOFF). The
  `mail-protocol.md` lays out the litmus test ("if the recipient's session
  dies and restarts, do they need this?") and per-role mail budgets
  (polecats: 0-1 per session; dogs: zero).
- **Garden today.** `garden kick` is the only inter-process delivery —
  pastes a prompt to a worker's pane, exactly the nudge pattern. There is
  no persistent mailbox between workers (and largely no inter-worker
  collaboration today; workers are mostly solo).
- **Lift.** Low for the vocabulary (rename or alias `kick → nudge` in docs;
  optionally add a worker-side `garden nudge <worker> "<msg>"`). Medium-high
  for true mail with persistence + read tracking + cross-session delivery.
- **Impact.** Medium long-term, low today. Garden's workers don't currently
  collaborate. If/when they do (e.g., a Mayor-style coordinator, or
  cross-worker handoff handoff), persistent mail becomes load-bearing. Not
  before.
- **Verdict.** Adapt the vocabulary now (frame `kick` as nudge in the
  worker prompt + docs). Defer mail until a concrete inter-worker handoff
  use case exists.

#### C2. Persistent identity, ephemeral session

- **Gastown.** Polecats have persistent identity (agent bead, BD_ACTOR like
  `gastown/polecats/toast`, CV chain across assignments) but ephemeral
  sessions (each work session is a new tmux + new worktree). Identity
  enables capability-based routing ("send Go work to polecats with Go track
  records") and model A/B comparison via consistent attribution.
- **Garden today.** Workers have a persistent name + persistent worktree;
  the tmux pane is the ephemeral part. There's no structured "CV chain" —
  history is in `garden logs -w <name>` and git author identity. The workers
  are not routed by capability; the operator picks where they go.
- **Lift.** Low to capture more identity metadata (completed iteration
  count, last-action type, project tags) on the existing registry entry.
  High to build capability-based routing on top.
- **Impact.** Low at current scope. Capability routing matters when a fleet
  is large and heterogeneous. Garden has effectively `default | trellis | grow`.
- **Verdict.** Defer. Worth flagging that the existing `WorkerEntry` is the
  right place if/when this becomes load-bearing — the trellis and grow
  per-workflow sub-objects (`entry.trellis`, `entry.grow`) are the pattern.

#### C3. Predecessor session discovery (Seance)

- **Gastown.** `gt seance` discovers predecessor sessions via
  `.events.jsonl` and supports `--talk <id>` for a one-shot or full-context
  conversation with a previous session. This lets a fresh agent ask its
  predecessor "what did you find?" instead of re-reading entire codebases.
- **Garden today.** `garden logs -w <worker>` shows historical log lines.
  Claude transcripts are stored in `~/.claude/projects/...` per
  `claude-env.ts` but garden does not surface them as queryable artifacts.
- **Lift.** Medium. A `garden ask <worker> "<question>"` that spawns a
  one-shot headless agent with that worker's transcript prepended, using
  the existing `headless-agent.ts` machinery, is a small primitive.
- **Impact.** Medium-low for a single-developer workflow — the operator can
  retrieve context themselves. Cleaner abstraction is the value, not raw
  capability gain.
- **Verdict.** Defer. Build when a concrete trellis / grow flow needs it
  (e.g., a continuation worker that needs to talk to its merged predecessor).

### Theme D — Extensibility

#### D1. Workflow overlays / role directives

- **Gastown.** Two layers of operator-controllable customization that don't
  require touching the binary:
  - **Role directives** — per-role markdown files
    (`~/gt/directives/<role>.md`, `~/gt/<rig>/directives/<role>.md`)
    spliced into prime output after the role template but before the
    formula. Town-level + rig-level concatenate.
  - **Formula overlays** — per-formula TOML
    (`~/gt/formula-overlays/<formula>.toml`,
    `~/gt/<rig>/formula-overlays/<formula>.toml`) that modify individual
    formula steps. Three modes: `replace`, `append`, `skip`. Rig-level
    fully replaces town-level.
- **Garden today.** Project-level rules layer (`<project>/.garden/rules.md`)
  exists and is appended into worker prompts via `buildWorktreeRules`. There
  is no per-workflow overlay — trellis-specific or grow-specific tweaks live
  in source.
- **Lift.** Low for per-workflow project-level overlays
  (`<project>/.garden/workflow-overlays/<workflow>.md`) that get spliced
  into the worker preamble at a defined hook point. Medium if you want a
  step-replace mechanism comparable to formula overlays.
- **Impact.** Medium. Today, project-specific tweaks to trellis or grow
  behavior require either a project-level rules paragraph that applies to
  every workflow or source modification. A workflow-scoped overlay is the
  missing dial.
- **Verdict.** Adopt the markdown-overlay variant. Skip the TOML formula
  step-replace — garden's workflows are TS code, not data, and that's the
  right call given `feedback_top_of_stack_dependencies`.

#### D2. Plugin system

- **Gastown.** Plugins are TOML-frontmatter + markdown-body files at
  town-level (`~/gt/plugins/`) or rig-level (`<rig>/plugins/`). Gates:
  cooldown, cron, condition, event, manual. Dispatched as Dogs (worker
  agents) by Deacon patrol. State tracked as wisps on the beads ledger.
  Use case: "rebuild gt binary when stale" — periodic maintenance work
  that doesn't fit a polecat assignment.
- **Garden today.** `postMerge` per-project command is the only extension
  hook. The user owns garden's source and patches directly.
- **Lift.** Medium-high. Loader, gate evaluator, dispatcher.
- **Impact.** Low while the operator is also the source maintainer. Plugins
  matter when operators are not engineers, or when a community wants to
  ship third-party automations.
- **Verdict.** Skip. Use `postMerge` for project-specific cleanup; revisit
  if external operators emerge.

#### D3. Multi-runtime support (Codex / Copilot / Gemini / etc.)

- **Gastown.** Ten built-in agent presets. Hook mechanism varies per
  runtime: Claude uses `settings.json` lifecycle hooks; Copilot uses
  `.github/hooks/gastown.json` JSON; OpenCode uses a JS plugin; runtimes
  without hooks (Codex) get a startup-nudge fallback. `gt config agent set
  <name> "<command>"` lets the operator alias custom commands.
- **Garden today.** Claude Code only. `claude-profile add/login/list/remove`
  manages multiple Claude accounts. The auto-continue logic in `continue.ts`
  uses Claude's transcript JSONL UUID, which is Claude-specific.
  `headless-agent.ts` shells out to `claude --output-format=stream-json`,
  which is Claude-specific. Sandbox / credentials / claude-env modules are
  Claude-shaped.
- **Lift.** Very high. The hook contract, transcript discovery, headless
  invocation, and per-runtime wrapper command would all need a runtime
  abstraction layer. Auto-continue logic in particular leans heavily on
  Claude's behavior model (PreCompact, Stop hook, transcript JSONL files).
- **Impact.** Variable. Other runtimes might be cheaper or specialize for
  particular tasks. But Claude Opus is currently best-in-class for the work
  garden does, and the user has explicitly chosen Claude as the primary tool
  (the harness is even called Claude Code).
- **Verdict.** Skip until Claude is genuinely insufficient or expensive
  enough to force the work.

### Theme E — Coordination patterns

#### E1. Convoys (cross-worker batched work)

- **Gastown.** Convoys are persistent tracking units that bundle related
  issues across rigs. Auto-created on `gt sling` for single-issue dispatches
  (so all work shows up in the dashboard). Land notifications fire when all
  tracked issues close. The "swarm" — workers currently on a convoy's issues
  — is ephemeral and derived from the convoy.
- **Garden today.** No batching primitive. The `handoff` skill spawns N
  workers in parallel but doesn't track them as a unit. Operator mentally
  groups "these 4 workers are doing the same thing" via worker names.
- **Lift.** Medium. A `batch` field on `WorkerEntry` (sibling to `trellis`
  and `grow`) plus a `garden batch list` view that groups workers by tag.
  The handoff skill stamps the batch tag at spawn time.
- **Impact.** Medium when fan-out is in use. Status pane could group
  spawned-together workers visually instead of alphabetically.
- **Verdict.** Adapt. Tag-based grouping is the cheap variant; skip the
  cross-rig story (garden doesn't have rigs).

#### E2. The Mayor pattern (AI coordinator)

- **Gastown.** A persistent AI coordinator the human talks to. Instead of
  CLI commands, the human says "build feature X" and the Mayor decomposes
  into convoys, dispatches polecats, summarizes back. The MEOW workflow
  ("Mayor-Enhanced Orchestration Workflow") is the recommended UX.
- **Garden today.** Operator-driven CLI. Trellis and grow handle intra-task
  iteration; cross-task orchestration is human.
- **Lift.** Very high. Building a Mayor requires a coordinator role with
  tools to spawn workers, monitor state, and respond to operator intent.
  Plus: a different conversation mode ("operator-and-Mayor" rather than
  "operator-and-CLI"). And: failure-mode handling for "Mayor made the wrong
  call."
- **Impact.** Potentially very high if it works (converts garden from
  human-driven to Mayor-driven). Failure mode is also high (wrong Mayor
  decisions amplify into wasted compute and bad merges).
- **Verdict.** Defer with a note. Garden's existing trellis is closer to a
  "Mayor for one task" than is obvious — it carries the problem statement,
  decomposes into iterations, and reports back. A Mayor-for-many-tasks would
  be the same pattern with cross-project state. Worth designing carefully
  before building.

### Theme F — Sandboxing and isolation

#### F1. Remote container execution (daytona)

- **Gastown.** Spec'd in `docs/design/sandboxed-polecat-execution.md`: the
  agent runs in a remote daytona container; control plane (gt/bd) and git
  fetch/push tunnel through a local mTLS proxy (`gt-proxy-server` /
  `gt-proxy-client`); the container has zero outbound internet. Per-polecat
  short-lived certs (CN = `gt-<rig>-<name>`) enforce branch-scoped push
  authorization. Local nudge via `tmux send-keys` into the `daytona exec`
  pane works unchanged.
- **Garden today.** Local UID + Seatbelt (macOS) or bubblewrap (Linux) via
  `sandbox.ts`. Restricted filesystem, no remote execution.
- **Lift.** Very high. mTLS proxy, cert issuance, devcontainer profile,
  workspace lifecycle, git endpoint relay. Plus: figuring out the right
  remote provider (daytona is one option; not the only one).
- **Impact.** Niche. The user runs garden on their daily workstation; remote
  execution would matter only if they wanted to run on cheaper hardware,
  isolate untrusted code, or run from a phone.
- **Verdict.** Skip. Garden's existing local sandbox is sufficient for the
  current threat model.

## 3. Roadmap

Three phases, ordered by lift × impact, with explicit gates between them.

### Phase 1 — Operator-visibility wins (1-2 months)

Each item is independently shippable. None depends on a foundation rewrite.

| Item | Source lessons | Why now |
|---|---|---|
| `garden escalate <severity> "<msg>"` worker verb writing to alerts with stable dedup | A2 | Cleanest separation of "stuck" vs "failed review" with the lowest lift in the doc. |
| Stalled-state classifier (`stalled` boolean derived from `lastActivityTs`) shown on header / status pane and emitting a one-shot alert at threshold | A1 | Direct operator-load reduction. |
| Structured JSONL event stream + `garden stats` command | A3 | Foundation for A4 and for answering quota / iteration / review-pass-rate questions. |
| Capacity governor: `maxConcurrentWorkers` (machine-level) + queue file + poller-driven drain | B1 | One mistake away from quota exhaustion right now. Cheap fix. |
| Vocabulary alignment: rename `kick` → `nudge` in docs and worker prompts (keep `kick` as alias) | C1 | Pure rename, sets up future mail vs nudge distinction. |
| Per-workflow project-level overlay (`<project>/.garden/workflow-overlays/<workflow>.md`) | D1 | Currently the only way to tweak trellis/grow per-project is a global rules paragraph. |

**Phase 1 acceptance.** All five ship to main without changing the on-disk
schema enough to require migration. `garden stats` answers at minimum:
average trellis iteration count to merge, daily worker spawn count by
project, daily auto-continue invocations, daily quota burn rate.

### Phase 2 — Structural improvements (3-6 months)

| Item | Source lessons | Depends on |
|---|---|---|
| Activity-feed pane with problems-mode filter (replaces or augments the logs pane) | A4 | Phase 1's structured events |
| Batch / swarm tag on `WorkerEntry` + `garden batch list` view + handoff skill stamps batch ID at spawn | E1 | None |
| Quota-aware capacity governor: pause spawn when `usage` is in warning band | B1 + Phase 1 governor | Phase 1's capacity governor |
| Predecessor session discovery: `garden ask <worker> "<question>"` that wraps `headless-agent.ts` with the worker's transcript | C3 | None |
| Worker identity enrichment on `WorkerEntry` (cumulative iteration count, last-action category, project tags) without yet wiring routing | C2 | None |

**Phase 2 acceptance.** The dashboard surfaces a problems-first view that
reaches a useful insight in under three keystrokes, and fan-out via handoff
produces a visually-grouped status display rather than a flat list.

### Phase 3 — Ambitious / optional (6-12 months, gate on demand)

| Item | Source lessons | Trigger condition |
|---|---|---|
| OTLP backend for the structured event stream | A3 (extension) | The user actually runs a metrics backend |
| Web dashboard (htmx-style) for remote / mobile viewing | A4 (extension) | The user wants to monitor garden from somewhere other than the workstation |
| True persistent mail between workers (not just nudge) with read tracking and inbox | C1 (extension) | A concrete inter-worker handoff use case emerges (e.g., a coordinator pattern) |
| Plugin system (TOML-defined cron-gated maintenance) | D2 | External operators or community plugins |

### Phase 4 — Explicit non-goals (and why)

These are ideas worth understanding from gastown and explicitly *not* on the
roadmap:

- **Bors-style bisecting merge queue (B2).** Garden's bottleneck isn't merge
  throughput; it's review quality. Batching trades the latter for the former.
- **Multi-runtime support (D3).** Auto-continue, hook contract, transcript
  discovery, and headless invocation are all Claude-shaped and work well.
  The lift to abstract over runtimes is high, the operator already prefers
  Claude, and Claude's model offering is best-in-class for this work.
- **Beads / Dolt as backing store.** Two memories converge here:
  `feedback_top_of_stack_dependencies` (wary of external tech at the
  orchestration layer) and `project_go_port_deferred` (Go port deferred,
  revisit only on concrete Beads/Board interop friction). Atomic JSON files
  with type guards are good enough at garden's scale and the user owns the
  layer end to end.
- **Wasteland federation.** Cross-machine work coordination is a multi-team
  / multi-org primitive. Garden is single-operator.
- **The Mayor (E2) — at least not yet.** The pattern is interesting but the
  failure mode (wrong-call amplification) and design lift are high. Trellis
  is already a Mayor-for-one-task. A cross-task Mayor needs a real spec
  before it should be built.
- **Daytona-style remote containers (F1).** The local Seatbelt / bubblewrap
  sandbox is sufficient for the threat model.

## 4. Open questions

These are decisions the operator should make before Phase 1 lands. Listed
here so they don't get lost in implementation:

1. **Stalled threshold.** Gastown defaults to "no progress for an extended
   period" but the literal duration is configurable. For garden's typical
   work (5-25 minute iterations), what's "stalled"? Suggestion: 10 minutes of
   `working` status with no new pane output, configurable per-project.

2. **Capacity governor scope.** Per-machine, per-project, or both? Gastown
   counts polecats town-wide because API rate limits are shared. Garden's
   answer is the same (one Claude account = shared limits) — a per-machine
   cap is the load-bearing one. Per-project is convenience.

3. **Event schema versioning.** The structured JSONL events from A3 will be
   read by `garden stats` and (later) the activity feed. Adopt a schema
   version field from day one and a migration policy, or commit to
   never-rename-fields? Suggestion: version field, additive-only changes.

4. **Workflow overlay precedence.** Garden's existing rules already layer
   global → project. Where does a workflow overlay sit — between project
   rules and the per-worker preamble, or fully at the end? The
   "more-specific-wins" precedent in gastown's directive overlays argues for
   "after the worker preamble," so the overlay can override anything earlier.

5. **Escalation routing.** Garden's escalation is operator-only (no
   Deacon → Mayor). But should `CRITICAL` differ from `MEDIUM` in any
   user-visible way (alert sound, terminal bell, force-flash the pane), or
   is the alerts ribbon's existing visual pop sufficient? Lower-stakes than
   it looks, but worth deciding before code lands.

## 5. References

### In gastown

- `docs/design/architecture.md` — overall system shape
- `docs/design/scheduler.md` — capacity governor design
- `docs/design/escalation.md` — severity routing
- `docs/design/mail-protocol.md` — mail vs nudge guidance and message types
- `docs/design/witness-at-team-lead.md` — future-direction Witness spec
- `docs/design/otel/otel-data-model.md` — full event schema
- `docs/design/sandboxed-polecat-execution.md` — exitbox + daytona spec
- `docs/concepts/propulsion-principle.md` — GUPP, the "if it's hooked, you run it" rule
- `docs/concepts/identity.md` — persistent identity / ephemeral session
- `docs/concepts/convoy.md` — cross-rig batched work
- `docs/glossary.md` — full term inventory
- `internal/witness/manager.go`, `internal/deacon/stuck.go` — actual stuck-agent detection
- `internal/refinery/engineer.go` — Bors-style merge queue
- `internal/scheduler/capacity/` — capacity governor implementation
- `internal/quota/state.go` — Claude account quota rotation (their analog of `usage.ts`)
- `internal/feed/curator.go` — activity-feed deduper / aggregator

### In garden

- `src/dashboard/registry.ts` — `WorkerEntry` shape and the per-workflow sub-object pattern
- `src/dashboard/alerts.ts` — current operator-visible signal channel
- `src/dashboard/poller.ts` + `src/dashboard/poller-{review,merge,resolve,fifo}.ts` — review/merge lifecycle
- `src/dashboard/continue.ts` — auto-continue (interrupt-recovery and post-merge)
- `src/dashboard/usage.ts` + `src/dashboard/usage-poller.ts` — Claude quota meter
- `src/dashboard/headless-agent.ts` — the primitive for any future Seance / Mayor work
- `src/dashboard/workflows/` — current workflow registry
- `src/rules.ts` — `buildWorktreeRules`, the splice point for any directive overlay
