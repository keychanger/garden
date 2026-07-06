# Crews: Codex as a First-Class Citizen

How garden makes Codex (and any future harness) a peer to Claude Code across
*every* role in *every* workflow — spawnable as a worker, selectable as a
reviewer, resolver, or ci-fix agent — and the operator surface that composes
those choices without exploding into a matrix of hand-written workflow
variants.

## Status

Forward-looking design. No code beyond what is already shipped (below). This
doc is the detailed worker-path-and-selection design that
[`MULTI-MODEL.md`](../MULTI-MODEL.md) Phase 4/5 and
[`AUTONOMY-PROGRAM.md`](AUTONOMY-PROGRAM.md) §4a point at — it does not
replace them. `MULTI-MODEL.md` owns the harness-adapter architecture and the
per-role resolution matrix; this doc owns (a) the **crew** concept — the
operator-facing bundle of role→harness/model assignments — and (b) the
remaining **Codex worker path**. Nothing here is a behavioral contract yet;
workers must not act on it (see `rules.md` § Specifications and documentation
and `docs/README.md` on `docs/future/`).

Where this doc and older docs disagree on shipped state, this doc is current:
`AUTONOMY-PROGRAM.md` §4a was written before the reviewer-first slices landed
and still calls the Codex adapter "zero code." That is stale — see below.

### What already ships

- The **Codex harness adapter**, both halves: `codex-core.ts` (command
  dialects, transient-error and quota matchers, rollout-JSONL `readTurns`,
  session identity) and `codex.ts` (`installRuntimeConfig` →
  `.codex/hooks.json` event relay), registered in both `harness/core.ts` and
  `harness/index.ts`.
- **Codex as reviewer / resolver / ci-fix**, today, via one command:
  `garden config <project> role reviewer harness codex`. `resolveReviewRole`
  (`dashboard/roles.ts`) resolves each review role's `{harness, model,
  envPrefix}` independently. Live-verified against codex 0.142.5: `codex exec`
  performs full agentic review and emits a clean verdict on the last line of
  stdout, so `parseLastLineVerdict` holds.
- The **plumbing** the worker path needs: `WorkerEntry.harness`, the launch
  builders (`buildWorktreeWorkerCommand` / `buildWorktreeBootstrapScript` /
  `buildWorktreeResumeCommand`) all accept `opts.harness` and route through
  `getHarness(opts?.harness).buildAgentCommand`, and `installRuntimeConfig` /
  transcript reading / prompt delivery already dispatch through the adapter.

### What does not ship (the subject of this doc)

The **Codex worker path**: no operator surface sets `entry.harness` for a
worker, the interactive launch is unsandboxed, no garden rules reach a Codex
worker, and session identity is not recovered. Detailed and ranked below.

## Thesis: a crew is not a workflow

The tempting framing — "a full-Anthropic workflow, a full-Codex workflow, and
mixed ones" — fuses two axes garden deliberately keeps orthogonal. Do not
implement it literally. If "who runs each role" becomes part of a
`WorkflowDefinition`, you get a combinatorial explosion:

```
{default, trellis, grow, holistic-review}
   ×
{all-claude, all-codex, claude-builds/codex-reviews, codex-builds/claude-reviews, …}
```

Every new workflow multiplies by every role-assignment, and every new harness
multiplies again. That is precisely the fork-in-the-state-machine the Phase
1–4 refactor spent its budget escaping.

The shipped architecture already separates the two axes:

| Axis | What it selects | Where it lives |
|---|---|---|
| **Workflow** | The *lifecycle*: how many review passes, is there a frozen spec, is it a bounded loop, who dispatches the next iteration. | `WorkflowDefinition` (`workflows/*.ts`). Values: `default`, `trellis`, `grow`, `holistic-review`. |
| **Crew** (this doc) | *Who* runs each role — worker / reviewer / resolver / ci-fix — each resolving `(harness, model[, provider])` independently. | `project.roles` + the flat `provider`/`harness` keys, resolved by `resolveRole`. |

"Full Anthropic," "full Codex," "Claude builds / Codex reviews" are **not
lifecycles.** They are the *same* lifecycle (usually `default`) with different
role→harness assignments. They belong on the crew axis. A crew composes with
*any* workflow, so the surface stays `O(workflows + crews + harnesses)`, never
their product:

```
garden workers new <p> --workflow trellis --crew codex-build-claude-review
```

**Naming.** "Crew" is a proposal, not settled — it answers "who's on the
job." Alternatives considered: "recipe" (faintly claimed by the ultracode
comment in `workers.ts`), "roster," "lineup," "cast." Pick one and use it
everywhere; the concept matters more than the word.

### "Plan" is not a role today

The operator's original instinct — "Claude plans, Codex reviews" — names a
role garden does not have. The `default` workflow's roles are **worker**
(builds), **reviewer**, **resolver**, and **ci-fix**. "Claude plans" collapses
to "Claude worker" in current terms. A distinct **plan/design role** is a
genuinely good future (see Futures) and is exactly the territory of
[`BOTANIST-WORKFLOW.md`](BOTANIST-WORKFLOW.md) and
[`PLAN-WORKFLOW.md`](PLAN-WORKFLOW.md) — but it does not exist in the pipeline
yet, and a crew selector must not be designed around a role that isn't wired.

## The crew model

A **crew** is a named bundle of role→assignment mappings. It is sugar over the
per-role resolution that already exists for the review family; it does not
introduce a new resolution mechanism.

### The four canonical crews

| Crew | worker | reviewer (+ resolver + ci-fix) | Status |
|---|---|---|---|
| `all-claude` | claude-code | claude-code (Opus) | ships (the default) |
| `claude-build-codex-review` | claude-code | codex | **ships today** (`config role reviewer harness codex`) |
| `codex-build-claude-review` | codex | claude-code (Opus) | needs the worker path |
| `all-codex` | codex | codex | needs the worker path |

Two of the four already work. The worker path unlocks the other two, and the
crew names are the ergonomic wrapper over the role keys.

### Resolution semantics

Generalize the shipped `resolveReviewRole(project, workflow, role)` into the
`resolveRole(project, workflow, role) → {harness, model, provider?}` the
`MULTI-MODEL.md` Phase 4 design already names, adding the **worker** role:

- **harness**: `roles.<role>.harness` → (worker: flat `harness` key →
  `"claude-code"`; review roles: `"claude-code"`). Validated strictly against
  the registry (`isRegisteredHarness`) at the operator surface — an unknown
  harness fails loudly, not at launch.
- **model**: `roles.<role>.model` → (worker: `entry.model` / `--model` →
  workflow `workerModel` → account default; review roles: workflow
  `reviewerModel` → `SAFE_REVIEW_MODEL` (Opus) on claude-code, else harness
  default). Opaque string; Anthropic aliases resolve through the provider
  `modelMap`, meaningless to a foreign harness (so an unpinned Codex role gets
  no `-m` flag and uses its own account default — the shipped
  `resolveReviewRole` behavior, preserved).
- **provider**: **worker only.** Review roles structurally reject a provider
  (a provider only ever defeats the reviewer safety net) — unchanged from
  today. And worker-provider stays the **flat `provider` key**, not
  `roles.worker.provider`: the `MULTI-MODEL.md` Phase 4 decision explicitly
  rejects a higher-precedence `roles.worker.provider` to avoid split-brain.
  `roles.worker` carries `harness` and `model` only.

A crew is then a preset that fills those slots. `crew all-codex` expands to
`roles.worker.harness=codex, roles.reviewer.harness=codex,
roles.resolver.harness=codex, roles.ciFix.harness=codex`. Setting a crew and
setting individual role keys are the same underlying write; the crew is a
convenience, and the granular keys remain the escape hatch.

## The worker-path gaps, ranked

The plumbing is threaded; these are the substantive gaps, ordered by risk.

### 1. Sandbox — a correctness blocker, not a nicety

`codexCore.buildAgentCommand` hard-codes
`--dangerously-bypass-approvals-and-sandbox` on the **interactive worker**
launch (fresh and resume). For the short-lived headless reviewer, garden owns
the trust boundary and that is defensible. For an autonomous worker looping
unattended it means **no sandbox at all**, violating requirement #4 of
`MULTI-MODEL.md` ("run unsandboxed… is unacceptable for autonomous workers").

The worker launch must translate garden's existing `buildSandboxConfig`
(writable roots + egress hosts) into Codex's native `sandbox_mode =
"workspace-write"` + `[sandbox_workspace_write]` writable_roots + network
allowlist in `config.toml`.

**The macOS footgun (load-bearing).** In `workspace-write`, Codex disables
network by default, and on macOS the Seatbelt sandbox **silently ignores**
`network_access = true` (openai/codex #10390, #13373). An autonomous worker
that must `git push` to origin therefore cannot rely on `network_access` on a
Mac. Options, in preference order:

- **Push outside the sandboxed turn.** Garden already owns the pane's shell
  scaffolding; the agent commits inside the sandbox and a garden-owned,
  non-sandboxed post-turn step performs the push. Cleanest — it keeps the
  agent sandboxed for all of its own work and confines network to a garden
  step, not agent-controlled code.
- **`--sandbox danger-full-access`** for the whole worker. Rejected for
  autonomous workers: it is exactly the unsandboxed posture requirement #4
  forbids.
- **A local egress proxy** the sandbox is allowed to reach. Heavier; defer.

This gap gates shipping a Codex *worker* at all. Until it lands, `workers new
--harness codex` should be **refused** with a concrete message, not shipped
half-safe. Gate at spawn on the sandbox being *actually honored*, not merely
declared in `capabilities`.

### 2. The turn-end spike — de-risk before everything

Requirement #1 (a turn-end signal reaching the FIFO) is non-negotiable, and
STATUS.md forbids polling around a missing one. Two unverified facts gate the
entire worker path, and they interact:

- **Mechanism.** The shipped `codex.ts` relays turn-end via
  `.codex/hooks.json` `Stop` (requiring `--dangerously-bypass-hook-trust`,
  since garden writes the file programmatically). `AUTONOMY-PROGRAM.md` §4a
  instead describes consuming `codex exec --json`'s inline `turn.completed`
  event — but that is a *headless* stream, not the interactive TUI. The
  interactive worker has no consumable `--json` stream in its pane, so
  `hooks.json` `Stop` is the right mechanism for it.
- **The unverified claim:** that `hooks.json` `Stop` fires **per-turn in the
  interactive TUI** with the trust bypass. Verified for `codex exec`
  (headless); not for the long-lived pane.

Spike this first, cheaply: launch `codex --dangerously-bypass-hook-trust` in a
pane with a garden `hooks.json`, drive one task, confirm `Stop` fires
`dist/hook.js stop` → FIFO poke → review entry. If it does not fire reliably,
the worker path is blocked and garden stays reviewer-only — which is a fine
resting state. Everything below is comfortable engineering *once this holds.*

### 3. Rules delivery + the AGENTS.md collision

Today Codex `installRuntimeConfig` writes only `hooks.json` + git-excludes —
**no garden rules reach a Codex worker.** Claude gets rules via
`--append-system-prompt-file`; Codex has no system-prompt flag and reads
`AGENTS.md`. The garden rules (global + project + the `buildWorktreeRules`
preamble that names the `checks` command, plus skills folded into prose since
`capabilities.skills` is false for Codex) must reach the worker.

The trap: many repos ship their **own** `AGENTS.md`, and garden must never
clobber it. Recommended posture: **never touch the repo's `AGENTS.md`.**
Deliver garden's rules through a garden-owned path Codex is pointed at (a
`CODEX_HOME`-scoped doc or a `--config`-referenced file), not by
merge-and-restore of a repo file (fragile across crashes/interrupts). The
exact Codex mechanism moves between releases — re-verify against the pinned
Codex version before committing to one.

### 4. Session-identity recovery

Codex mints its own `thread_id`; `codexCore.allocateSessionId()` returns `""`
by design. `HarnessCore` needs the `recoverSessionId(entry)` method
`AUTONOMY-PROGRAM.md` §4a names: capture the assigned id from the first hook
payload (or the rollout filename) onto `entry.sessionId`, and route
bounce/resume/loop-respawn through `codex resume <thread_id>`. Nothing
persists it today, so a bounced Codex worker cold-starts and loses its thread.

### 5. `continue.ts` / `header.ts` call-site routing

Auto-continue prompt injection (`continue.ts`) and the `⌥h` history view
(`header.ts`) still hard-call the claude path inside the hook-bundle closure
(`MULTI-MODEL.md` Layer 3 admits this deferral). `codexCore.deliverPrompt` and
`readTurns` are *written*; the call sites just need to route through
`getHarnessCore(entry.harness)` instead of assuming claude. Without it,
auto-continue pastes into a Codex pane via the wrong contract and the history
view renders empty.

### 6. Selection surface + capability gate

`resolveRole` generalized to the worker (§ The crew model); a `garden config
<p> harness` worker default and `roles.worker.harness`; `workers new --harness
codex`; and a **capability gate at spawn** that refuses any harness whose
`turnEnd`/`sandbox` do not hold (surfaced at `workers new`, not discovered in
production — `MULTI-MODEL.md` "Capability tiers"). Persist to `entry.harness`;
the launch builders already consume it.

## Sequenced slices

Each slice independently mergeable, the Claude-only fleet byte-identical, full
gate green — the same discipline the reviewer-first slices used.

1. **Spike (gap 2).** Prove interactive `Stop` → poller. Blocks all of the
   below; settle first.
2. **Sandbox translation (gap 1).** `buildSandboxConfig` → Codex
   `config.toml`; resolve the macOS self-push path (push-outside-the-turn
   preferred). The correctness gate.
3. **Rules + AGENTS.md (gap 3).** Garden rules to a Codex worker without
   clobbering a repo `AGENTS.md`.
4. **Selection + capability gate (gap 6).** `resolveRole` worker generalization,
   `config harness` / `--harness`, spawn-time gate, `entry.harness` persisted.
5. **Session identity (gap 4).** `recoverSessionId`; bounce/resume/loop via
   `codex resume`.
6. **Continue/history routing (gap 5).** Route `deliverPrompt`/`readTurns`
   through the adapter.
7. **Crews + picker (this doc's UX).** Named crews as sugar over the role
   matrix; `⌥⇧N` gains a crew dimension.

## Operator surface

- **Config keys.** `garden config <p> harness <name>` (worker default);
  `garden config <p> role <role> harness|model <value>` (per-role, already
  exists for the review family, extended to `worker`); `garden config <p> crew
  <name>` (preset that writes the role keys). The flat `provider` key is
  unchanged and worker-only.
- **`workers new`.** `--harness <name>` (per-worker override) and `--crew
  <name>`. Both validated against the registry / crew presets; unknown values
  fail loudly.
- **`⌥⇧N` picker — a second dimension, not more rows.** The picker selects a
  workflow today (`(t)`/`(g)` rows). Adding "all-codex," "mixed-A," "mixed-B"
  as sibling rows *is* the combinatorial trap in UI form. Instead: pick
  workflow, then optionally pick crew, defaulting the crew from project config
  so the picker is for *overrides*. Most operators set a project default crew
  once and never open the picker; the picker is for "this one's a Codex
  experiment."

## Safety and invariants

- **Reviewer-strong stays the default.** The shipped invariant — review family
  defaults to strong first-party Anthropic Opus, and a provider can never
  reach a review role — is the safety net that makes a cheap or experimental
  *worker* safe to try. Crews do not relax it; a crew that assigns a weaker
  reviewer is an explicit operator choice, per role.
- **Cross-harness review is a feature, not just a fallback.** See Futures.
- **Capability gating is enforced, not documented.** A harness ineligible for
  workers (no honored sandbox, no interactive turn-end) is refused at spawn.
- **Byte-identical Claude fleet.** Every slice leaves an all-Claude project's
  behavior bit-for-bit unchanged; the crew/harness resolution defaults collapse
  to today's code paths when unset.

## Futures worth betting on (not building yet)

- **Cross-harness review as a correctness *multiplier*.** The strongest case
  for mixed fleets is not "Codex is subsidized capacity" (though it is — a
  separate quota pool, per `AUTONOMY-PROGRAM.md` §4a). It is that a Codex
  reviewer over a Claude worker catches a *different class* of defect: different
  training, different blind spots. This reframes the safety invariant — for
  high-stakes tracks the rule might become **reviewer harness ≠ worker
  harness**, deliberately, to break the Opus-reviews-Opus monoculture
  (`AUTONOMY-PROGRAM.md` §4a's "rotating Codex second-opinion"). A quorum
  variant (two reviewers of different harnesses must both pass) is the
  high-assurance endpoint.
- **A real plan/design role.** The honest home for "Claude plans, Codex
  builds." If `resolveRole` resolves arbitrary roles, adding a `plan` role is
  data, not a fork — and it slots directly into
  [`BOTANIST-WORKFLOW.md`](BOTANIST-WORKFLOW.md) /
  [`PLAN-WORKFLOW.md`](PLAN-WORKFLOW.md).
- **Metering goes blind across harnesses.** Codex has no machine-readable
  quota endpoint; the auto-continue gate reads Anthropic buckets. A full-Codex
  fleet silently loses the usage gate (same as provider-backed projects
  today). The future is a neutral **spend/token gate** derived from
  transcripts — the token-usage object on Codex's `turn.completed` /
  headless-stderr trailer is a natural source. Cross-references
  [`MODEL-SELECTION.md`](MODEL-SELECTION.md).
- **Tracks × crews.** Once [`TRACKS.md`](../TRACKS.md) lands, the killer combo
  is a cheap/experimental crew on a lab track promoting through a
  strong-reviewer gate into main. Crews and tracks are orthogonal and multiply
  cleanly — which is only true if crew stays off the workflow axis.
- **opencode** for the open-model long tail (Tier A via its event bus), when
  Ollama-behind-Claude stops being enough (`MULTI-MODEL.md` Phase 5).

## What this doc does *not* propose

- Hardcoded workflow variants per harness assignment, or folding "who runs
  each role" into `WorkflowDefinition`. That is the combinatorial trap.
- A `roles.worker.provider` key. Worker-provider stays single-source (the flat
  `provider` key) to avoid split-brain — the shipped Phase 4 decision.
- A provider on any review role. It only ever defeats the safety net.
- Shipping a Codex *worker* before the sandbox translation (gap 1) and the
  interactive turn-end spike (gap 2). Both can invalidate the plan; settle them
  first.

## Open questions

- Does `hooks.json` `Stop` fire per-turn in the interactive Codex TUI under
  `--dangerously-bypass-hook-trust`? (Gap 2 — blocks everything.)
- macOS self-push: is push-outside-the-turn clean enough to be the default, or
  does it complicate the commit/push discipline garden's rules prescribe?
- The exact non-clobbering mechanism for garden rules vs. a repo `AGENTS.md`,
  pinned to a specific Codex release.
- Codex's `--output-schema` is documented broken when MCP tools are active
  (and can degrade the `--json` stream) — does garden's worker path touch
  either? (Reviewer path avoids both.)
- Where the `plan` role, if built, resolves its harness/model from — the same
  `resolveRole`, or a workflow-owned default.

## Cross-references

- [`MULTI-MODEL.md`](../MULTI-MODEL.md) — the harness-adapter architecture and
  the per-role resolution matrix. Phase 4 (Codex reviewer) shipped; Phase 5
  (Codex worker completion) is the work this doc details.
- [`AUTONOMY-PROGRAM.md`](AUTONOMY-PROGRAM.md) §4a — the program-level placement
  of Codex-as-second-harness and the macOS/self-push and `recoverSessionId`
  caveats. (Its "zero code" claim for the adapter is stale — see Status.)
- [`WORKFLOWS.md`](../../WORKFLOWS.md) — the workflow axis crews compose with.
- [`BOTANIST-WORKFLOW.md`](BOTANIST-WORKFLOW.md),
  [`PLAN-WORKFLOW.md`](PLAN-WORKFLOW.md) — the plan/design-role future.
- [`MODEL-SELECTION.md`](MODEL-SELECTION.md) — the model dimension of the role
  matrix and the metering-gate future.
