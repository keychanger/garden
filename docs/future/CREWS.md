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

### What ships now (the Codex worker path — runnable)

As of 2026-07-06 a Codex worker runs end-to-end: `garden workers new <project>
--harness codex` spawns a sandboxed, rules-aware Codex worker that commits,
pushes, and signals turn-end into the review/merge pipeline. Verified against
codex 0.142.5 in a real linked worktree (commit + push under `workspace-write`,
all lifecycle hooks firing via `-c` injection). What landed:

- **Sandbox** (gap 1): `workspace-write` + `network_access` + writable roots
  including the shared git common dir (a linked worktree's git store).
- **Hooks** (gap 2): the lifecycle relay injected as `-c` overrides on the
  launch — NOT a `.codex/hooks.json` file (Codex loads project hooks from the
  repo root, so a worktree file never fires).
- **Rules** (gap 3): garden's composed rules delivered as the worktree
  `AGENTS.md` (Codex's only instruction channel; loads from cwd), composing
  over a repo's own `AGENTS.md` without clobbering it.
- **Directory trust** (gap 3): pre-seeded for the REPO ROOT in
  `CODEX_HOME/config.toml` (Codex scopes trust to the main checkout for a
  linked worktree), so the worker never halts on the trust prompt.
- **Selection** (gap 6): `workers new --harness codex`, validated against the
  registry, persisted to `entry.harness`, threaded through the bootstrap.

### Also shipped — multi-phase, history, session id (2026-07-06)

- **Multi-phase auto-continue** works for a Codex worker: `continue.ts` drives
  the pane via `pasteAndSubmit`, which *is* Codex's `deliverPrompt` contract,
  and `transcript_path` capture is harness-neutral — so a Codex worker builds
  → merges → auto-continues to the next phase like a Claude worker.
- **History view** (`⌥h`): `header.ts` now reads the transcript through the
  worker's adapter (`getHarnessCore(entry.harness).readTurns`), so a Codex
  worker's rollout renders correctly; the claude-code path is byte-identical
  (its adapter methods wrap the same `conversation.ts` functions).
- **Session-identity capture** (gap 4): the hook handler captures the
  Codex-assigned `session_id` onto `entry.sessionId` when the worker has none
  (guarded so a Claude worker's minted id is never overwritten), wiring up
  `bounce`/resume via `codex resume <id>`.

### What does not ship yet

- **Live-verified `codex resume`**: the capture + resume wiring is in place, but
  `codex resume <captured-id>` restoring a bounced worker's thread is not yet
  live-verified (the id and rollout filename match, so it should hold).
- **`deliverPrompt` draft-detection** for Codex: auto-continue works, but its
  unsent-draft guard keys on Claude's `❯` prompt marker, not Codex's `›`, so it
  can't yet detect a half-typed Codex message (minor; the paste still lands).
- **Project-default harness** (`config <p> harness`) and `--harness` for
  trellis/grow: deferred; `--harness codex` on the default workflow is v1.

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

## The crew model — SHIPPED (2026-07-10, `src/dashboard/crew.ts`)

A **crew** is a pair of **members** — `<worker>-<reviewer>`, with `all-X` sugar
when one harness both builds and reviews. `garden config <p> crew <name>` is
sugar that sets the worker harness/provider *and* the three review-role
harnesses together; it introduces no new resolution mechanism (it writes the
existing `harness`/`provider`/`roles.*` keys).

A **member** is *data*, not code: the registered harnesses (`claude`, `codex`)
plus one per configured provider (`deepseek` → claude-code against that
backend). So DeepSeek, Ollama, a future harness like opencode — each slots in
as a member and expands the crew set with **zero crew code**. This is the
payoff of keeping axis 1 (provider) and axis 2 (harness) orthogonal: a crew
composes over both under one operator-facing name.

**The load-bearing asymmetry:** any member may BUILD (worker), but only harness
members may REVIEW. A provider on a review role defeats the safety net (a
cheap/experimental worker must be reviewed by a strong first-party model), so
provider members are worker-only. Hence `deepseek-claude` / `deepseek-codex`
are valid crews but there is no `*-deepseek` — a DeepSeek worker is always
reviewed by strong Claude or Codex.

### The crews (generated from members)

For members `{claude, codex}` + a configured `deepseek` provider, `listCrews`
generates:

| Crew | worker | reviewer (+ resolver + ci-fix) |
|---|---|---|
| `all-claude` | claude-code | claude-code (default) |
| `all-codex` | codex | codex |
| `claude-codex` | claude-code | codex |
| `codex-claude` | codex | claude-code |
| `deepseek-claude` | claude-code + deepseek provider | claude-code |
| `deepseek-codex` | claude-code + deepseek provider | codex |

`deriveCrew` reports a project's current crew (null when hand-tuned, e.g.
reviewer ≠ resolver); `applyCrew` is authoritative over the worker
harness/provider + the three review harnesses, clearing to default what the
crew doesn't set. The naming (worker-first `<worker>-<reviewer>`) generalizes:
a new provider `foo` yields `foo-claude`/`foo-codex` automatically.

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

### 1. Sandbox — BUILT (2026-07-06, codex 0.142.5)

`codexCore.buildAgentCommand` used to hard-code
`--dangerously-bypass-approvals-and-sandbox` on the **interactive worker**
launch. For the short-lived headless reviewer that is defensible (garden owns
the trust boundary); for an autonomous worker looping unattended it meant **no
sandbox at all**, violating requirement #4 of `MULTI-MODEL.md`. The worker
launch now renders Codex's own `workspace-write` sandbox instead
(`codexSandboxFlags`): `-s workspace-write -a never -c
sandbox_workspace_write.network_access=true -c
sandbox_workspace_write.writable_roots=[...]`. cwd and `/tmp` are writable by
default; the extra roots mirror the HOME-based entries of `sandbox.ts`
`DEFAULT_ALLOW_WRITE`, **plus the worktree's shared git common dir**
(`AgentCommandOptions.worktreeGitDir`, resolved via `getGitCommonDir`). That
last root is load-bearing: a garden worker runs in a *linked* worktree whose
git store lives at the main checkout's `.git`, outside cwd — Codex
`workspace-write` does not auto-grant it (Claude Code's sandbox does), so
without it a Codex worker could not `git commit`/`push`. The reviewer's
headless command keeps the blanket bypass — unchanged. Dormant until selection
(gap 6) sets `entry.harness`.

**The macOS footgun is GONE — verified fixed.** Prior docs (`AUTONOMY-PROGRAM.md`
§4a, openai/codex #10390/#13373) warned that macOS Seatbelt *silently ignores*
`network_access = true` in `workspace-write`, which would have forced a
push-outside-the-turn workaround. Re-verified directly against codex 0.142.5
with `codex sandbox`: default `workspace-write` blocks network (curl → "could
not resolve host"), and `workspace-write` + `network_access=true` → HTTP 200.
**The bug is fixed**, so a Codex worker `git push`es to origin from inside its
sandbox exactly like a Claude worker — no workaround needed.

**One fidelity gap, documented not fixed.** Codex's `network_access` is
**boolean** — no per-domain egress allowlist (`allowed_domains` is ignored,
verified: github still reachable). So garden's Claude-side domain allowlist
(anthropic/github/npm) maps to `network_access=true` (all-or-nothing) for a
Codex worker; the worktree *filesystem* confinement is what the sandbox
actually enforces. Acceptable for v1 — the operator already trusts the worker
enough to run it autonomously — and noted here as a known posture difference
from Claude workers.

### 2. The turn-end spike — VERIFIED (2026-07-06, codex 0.142.5)

Requirement #1 (a turn-end signal reaching the FIFO) is non-negotiable, and
STATUS.md forbids polling around a missing one. This gated the entire worker
path. **It is now settled: the interactive Codex TUI fires `Stop` per turn.**

The mechanism question resolved first. The shipped `codex.ts` relays turn-end
via `.codex/hooks.json` `Stop` (requiring `--dangerously-bypass-hook-trust`,
since garden writes the file programmatically). `AUTONOMY-PROGRAM.md` §4a
instead describes consuming `codex exec --json`'s inline `turn.completed`
event — but that is a *headless* stream; the interactive worker has no
consumable `--json` stream in its pane, so `hooks.json` `Stop` is the right
mechanism, and the spike confirms it works.

**Spike setup.** A temp git repo with a garden-shaped `.codex/hooks.json`
(byte-identical to `buildCodexHooksJson`, runner swapped for an observing
probe), launched as an interactive `codex --dangerously-bypass-hook-trust
--dangerously-bypass-approvals-and-sandbox '<prompt>'` in a tmux pane, driven
for two turns.

**Results — all green:**

- **`Stop` fires once per turn.** Two turns produced exactly two `Stop`
  firings (not one at session end). `SessionStart` fired once; `UserPromptSubmit`
  fired per turn. This is the gate, and it holds.
- **The command-string arg parsing garden relies on works.** `buildCodexHooksJson`
  emits `command: "<runner> <wire-event>"` (runner + arg in one string); Codex
  shell-splits it and passed `stop`/`prompt`/etc. as `$1`. The format is correct.
- **The `Stop` stdin payload carries everything `readHookInput` needs**, and
  more: `session_id` (a UUID), `transcript_path` (the exact
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` path — no reconstruction
  needed), `cwd`, `hook_event_name`, plus bonus `turn_id`, `model`,
  `permission_mode`, `stop_hook_active`, and `last_assistant_message`.
- **`send-keys` prompt delivery drives the TUI** (turn 2 was injected this
  way) — early corroboration for gap 5 (`deliverPrompt`). Caveat observed:
  the empty Codex input box paints a dimmed ghost-suggestion that
  `capture-pane` renders as literal text — the *same* draft-vs-placeholder
  hazard `continue.ts` already handles for Claude, so the auto-continue
  draft-detection guard must extend to Codex.

**One new blocking integration requirement surfaced — the directory-trust
prompt.** On first entry into an untrusted directory the interactive TUI
halts on "Do you trust the contents of this directory?" *before* running
anything. `--dangerously-bypass-hook-trust` covers *hook* trust, **not**
*directory* trust — they are separate gates. An autonomous worker cannot
answer an interactive prompt, so garden must pre-seed trust: write
`[projects."<worktree>"]\ntrust_level = "trusted"` into `$CODEX_HOME/config.toml`
at bootstrap (this is what the pre-existing `[projects."..."]` blocks in a
used config.toml are). This belongs in `installRuntimeConfig` (gap 3) and is
now part of that slice.

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

This slice also owns **directory-trust pre-seeding** (surfaced by the spike,
gap 2): `installRuntimeConfig` must write `[projects."<worktree>"] trust_level
= "trusted"` into `$CODEX_HOME/config.toml` so the interactive worker does not
halt on the untrusted-directory prompt. It is idempotent and separate from
`--dangerously-bypass-hook-trust` (which only covers hook trust).

### 4. Session-identity recovery

Codex mints its own session id; `codexCore.allocateSessionId()` returns `""`
by design. `HarnessCore` needs the `recoverSessionId(entry)` method
`AUTONOMY-PROGRAM.md` §4a names. The spike (gap 2) makes this cheap: **every
hook payload carries `session_id` (a UUID) and `transcript_path` directly.**
So garden captures the id from the first hook payload onto `entry.sessionId`
(and `transcript_path` onto `entry.transcriptPath`, exactly the Claude
hook-captured path pattern — no rollout-filename reconstruction needed for a
live worker), then routes bounce/resume/loop-respawn through `codex resume
<session_id>`. Nothing persists it today, so a bounced Codex worker
cold-starts and loses its session; the fix is a few lines in the hook
dispatcher plus the resume plumbing.

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

1. **Spike (gap 2). DONE (2026-07-06).** Proved interactive `Stop` fires
   per-turn with the payload garden needs. Surfaced the directory-trust
   requirement (now folded into slice 3). See gap 2.
2. **Sandbox translation (gap 1). DONE (2026-07-06).** `codexSandboxFlags` →
   `workspace-write` + `network_access` + writable roots. The macOS network
   bug is verified fixed, so no push-outside-the-turn workaround. See gap 1.
3. **Rules + AGENTS.md + directory-trust + hooks (gaps 2/3). DONE (2026-07-06).**
   Rules delivered as the worktree `AGENTS.md` (composing over a repo's own
   without clobbering); trust pre-seeded for the REPO ROOT; the hook relay
   injected via `-c` on the launch (NOT a file — Codex loads project hooks from
   the repo root). Delivered additively: the bootstrap keeps the (inert-for-
   Codex) inline claude config and calls `_install-worker-runtime` after
   worktree setup, so the claude script stays byte-identical.
4. **Selection + capability gate (gap 6). DONE (2026-07-06).** `workers new
   --harness codex` validated against the registry, persisted to
   `entry.harness`, threaded through the bootstrap. Project-default `config
   harness` and `roles.worker` deferred (the flag is the v1 surface).
5. **Session identity + history routing (gaps 4/5). DONE (2026-07-06).** The
   hook captures the Codex-assigned `session_id` onto `entry.sessionId` (wiring
   `bounce`/resume); the `⌥h` history view routes transcript reading through
   the adapter. Multi-phase auto-continue already worked (identical paste +
   harness-neutral transcript capture). Remaining: live-verify `codex resume`
   and Codex-aware draft detection.
6. **Crews (config surface). DONE (2026-07-10).** `config <p> crew [<name>]`
   (`crew.ts`) — member-based, generated from harnesses + providers (so
   DeepSeek et al. compose for free), worker-only-provider safety asymmetry,
   plus the project-default `harness` key. The `⌥⇧N` picker crew dimension is
   the remaining UX polish (deferred — the config command is the functional
   surface; a project-level crew doesn't map cleanly onto the per-spawn
   workflow picker, so its shape is an open design question).

The full single- and multi-phase Codex worker experience landed 2026-07-06
(slices 1–5); the crew config surface landed 2026-07-10 (slice 6).

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
- Shipping a Codex *worker* before its remaining blockers land — rules
  delivery (gap 3), selection (gap 6), session identity (gap 4). Landing them
  out of order can invalidate the plan. (The sandbox translation, gap 1, and
  the turn-end spike, gap 2, are already settled — verified 2026-07-06.)

## Open questions

- ~~Does `hooks.json` `Stop` fire per-turn in the interactive Codex TUI under
  `--dangerously-bypass-hook-trust`?~~ **Resolved 2026-07-06: yes** — see gap 2.
- ~~macOS self-push: is push-outside-the-turn clean enough to be the default?~~
  **Moot 2026-07-06:** the Seatbelt `network_access` bug is fixed in 0.142.5, so
  a `workspace-write` worker pushes normally — no workaround. See gap 1.
- The exact non-clobbering mechanism for garden rules vs. a repo `AGENTS.md`.
  Constrained now: `AGENTS.md` is Codex's *only* instruction channel (no
  `experimental_instructions_file`/`instructions_file` config key exists in
  0.142.5 — all rejected under `--strict-config`). So garden must own the
  worktree `AGENTS.md`, composing its rules with any repo-tracked original
  (skip-worktree to keep `git status` clean) rather than pointing Codex at a
  separate garden-owned file.
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
