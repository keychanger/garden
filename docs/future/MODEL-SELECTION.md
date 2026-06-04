# Automated Model Selection

> This document lives under `docs/future/` — it describes an unshipped
> design. Workers must not act on it (no model router exists beyond
> trellis's `resolveVineModel`, no `model`/`engine` config key, no effort
> plumbing, no provider abstraction). See `rules.md` § Specifications and
> documentation. If this doc disagrees with the code, the **code** is
> right and this doc is the aspiration.

Design assessment for automating model selection in garden: when, and to
which model (and eventually which provider), each agent should run — Opus
vs Sonnet vs Haiku, at what reasoning effort, optimized for cost and quota
when the operator is absent. The operator's stated goals: stop wasting
Opus on trivial work, never under-power a heavy cognitive load with Haiku,
and decide automatically because the operator is usually not watching.

## Status

Speculative. No code today beyond the existing trellis model logic
(`src/dashboard/trellis-model.ts`, `resolveVineModel`) and the single
`--model opus|sonnet` launch flag. Nothing below is implemented. This doc
exists to capture the analysis and a phased path, not to authorize work.

## The core reframe

Every hosted auto-router (OpenRouter `auto`, NotDiamond, RouteLLM) is a
blind a-priori predictor *because it has nothing else*: it sees a prompt
and must guess, before generation, how hard the task is. Garden is in a
structurally stronger position. It **owns the verifier** (the headless
reviewer) and it **owns a loop** (cold-respawn per iteration in
`src/dashboard/loop.ts`). That changes the problem from prediction to
measurement: you do not need to guess which model fits a task if a
trustworthy oracle tells you, after one cheap attempt, whether the cheap
attempt was good enough.

So the organizing thesis: **start at the safe default for each role, and
let garden's own free feedback — the reviewer's verdict, and especially
the size of the reviewer's own fix — correct the guess at the next loop
boundary.** Model selection in garden is a measurement-and-feedback
problem, not a classification problem.

There are **two orthogonal axes**, and garden emits neither
programmatically today:

- **Tier** (Haiku / Sonnet / Opus) — governs the *quota bucket* and the
  *hard quality floor*. Coarse; expensive to get wrong.
- **Effort** (low … max reasoning budget) — governs *depth within a tier*.
  Cheap to vary, rides the same launch string, and can never cross the
  Opus/Sonnet quota boundary. The operator's `/effort` concept is exactly
  this axis.

## Five hard constraints (verified against the code)

Any design must respect these. Each one invalidates an otherwise
attractive approach.

1. **The default workflow has no cold-respawn loop boundary.** Default
   workers are born once at plant; auto-continue does a *warm* `--resume`
   via `tmux send-keys` into the same live session
   (`continueWorker`, `src/dashboard/continue.ts`). The "free
   per-iteration re-resolution checkpoint" exists **only for trellis and
   grow** (`loop.ts`). A misrouted default worker runs to completion at
   the wrong tier with no escape hatch.

2. **There is no task text at the default plant point.** `newWorker` is
   called with no seed for the default workflow; the operator types the
   first prompt interactively *after* the pane spawns. An a-priori
   difficulty classifier at the default plant reads an empty string and
   can only default to Opus. The single biggest claimed win of a triage
   classifier is structurally unrealizable for the workflow that most
   needs it.

3. **`failCount` does not measure rework — the reviewer launders it.**
   When a worker submits weak code, the reviewer fixes it directly and
   emits the `fixed` verdict
   (`ReviewResult.verdict: "clean" | "fixed" | "failed"`,
   `src/dashboard/poller-review.ts`), then merges with `failCount`
   unchanged. A cheap model whose work the Opus reviewer substantially
   rewrote looks identical in the registry to a clean merge. The real,
   free, un-launderable underpower signal is **reviewer fix magnitude** —
   the diff between `entry.preReviewSha` and the merged tip, which the
   merge path already computes for the post-merge changed-files prompt.
   Route and learn on that, never on `failCount`. (See also
   `docs/` memory: failed reviews don't bounce back; the reviewer fixes
   directly.)

4. **The quota meter has three buckets, not a separate Opus pool.**
   `UsageData` exposes only `fiveHour`, `weekly`, and `sonnet`
   (`src/dashboard/usage.ts`). The code comment is explicit: on Max plans
   `seven_day_opus` is null and Opus usage rolls into the shared `weekly`
   meter; `seven_day_sonnet` is the populated Sonnet bucket. Consequences:
   moving work Opus→Sonnet *does* relieve the contended `weekly` meter
   (Sonnet draws its own pool), **but** there is no independent Opus pool
   to reserve or inspect, the Sonnet→Opus fallback itself draws `weekly`
   (it is not free), and the endpoint is rate-limited and the snapshot can
   be ~1 hour stale — too stale to drive real-money cross-provider reroute
   decisions.

5. **Three "free, already there" signals do not exist.** No `.garden-stuck`
   sentinel, no "same error twice → stop" rule, no no-progress/empty-diff
   detector. Grow's loop boundary carries only `{iteration, maxIterations}`;
   only trellis persists `lastVerdict` (`entry.trellis`). Any design that
   leans on these is paying for net-new plumbing, not reusing existing
   machinery.

## The asymmetry that drives every default

> Escalation is feedback-driven and safe. De-escalation has no failure
> signal.

A reject or a red CI is a free, trustworthy "go up." Nothing ever fires to
say "this could have been done cheaper." Therefore:

- **Escalation:** instant, reactive, per-respawn, aggressive.
- **De-escalation:** slow, offline, conservative, evidence-gated — never
  reactive.
- **Orient the default to the recoverable failure mode.** "Spent Opus on
  something trivial" is detectable and cheap. "Shipped Sonnet-quality work
  unattended that passed a glance-review" is undetectable precisely when
  it is most dangerous.

This resolves the central design tension ("start cheap and ascend" vs
"start strong and descend"): **it is conditional on whether the role has a
loop.** Roles with a loop escape hatch may default cheap because
escalation catches misses; roles without one default high and earn their
way down with evidence.

## Recommended design: a layered resolver

Not a bandit, not a trained classifier, not a five-tier provider lattice.
A small deterministic resolver — `resolveVineModel` generalized — that
every launch site consults. Layers, safest first:

**L0 — Floors (generalize trellis Invariant 10).** Promote "reviewer is
pinned to the top tier and never falls back" from a trellis special case
to a universal rule, and extend it to the **resolver** (merge-conflict
resolution is irreversible-if-wrong and currently runs the account
default). **Haiku is ineligible for any cognitive-load role** — worker,
reviewer, resolver, ci-fix. Nearly a no-op today (account default is
already Opus) but it removes the silent dependence on that fact and
encodes the guarantee. Ship first.

**L1 — Role/workflow tier defaults, conditioned on the escape hatch.**

| Role | Loop escape hatch? | Default tier | Rationale |
|---|---|---|---|
| Reviewer | n/a (gate) | Opus, pinned | Quality oracle; cascade theory wants the verifier to be the strongest model |
| Resolver | no | Opus | Irreversible semantic merges |
| Default worker | **no** | Opus (today's behavior) | No re-resolution boundary; cannot recover a misroute |
| Trellis vine | yes | Sonnet (already) | Existing, with quota fallback |
| Grow iteration | yes | Sonnet | Bounded hardening; escalates on reject/CI |
| CI-fix | yes (3-attempt budget) | Sonnet first, Opus final attempt | Mechanical — but guard the corruption vector below |

The only real behavior *changes* are grow → Sonnet and ci-fix →
Sonnet-first. Everything else makes the status quo explicit and safe.

**L2 — Effort axis (the cheapest lever).** Within a tier, scale reasoning
effort to the task: ci-fix first attempt at low effort, escalate effort
before escalating tier; reviewer at high. This rides the existing launch
chokepoint with zero credential/sandbox work — *if* Claude Code exposes
effort at launch (settings.json/env/flag). Garden emits no effort today,
so the exact knob must be confirmed; if it exists, it is the highest-ROI
change in this document.

**L3 — Evidence-driven escalation at the cold-respawn boundary** (trellis,
grow, ci-fix only). On a substantive reject, a red CI, or a large
reviewer-fix, bump tier (then effort) for the next iteration. One-way
ratchet within a task for hysteresis, but tolerate a single transient
failure — do not pin a whole five-iteration grow loop to Opus on one
flaky CI red; require the signal to repeat or down-weight it.

**L4 — Quota governor.** Generalize trellis's Sonnet-exhaustion logic
(`sonnetExhaustion`, `trellisOpusFallback`) into a shared, multi-bucket
policy: when `sonnet` is dry but `weekly` is flush, **escalate** rather
than degrade; pause-and-alert only when both are exhausted; provide a
partial-degradation valve so one project draining `weekly` does not stall
every project's low-stakes work. Per-project config knob (precedent:
`trellisOpusFallback`).

**L5 — Ledger (observe, do not learn).** Log every routing decision with
its context (tier, effort, workflow, project) and outcome (verdict,
reviewer-fix-magnitude, CI, iterations-to-merge, quota drawn) via a
deduped alert plus a JSONL. This is the reward channel a bandit would
need — but do **not** ship the bandit. A single operator merges too few
units per week to clear a confidence floor before model versions rotate.
Keep it as an audit trail and an operator-legible shadow ("here is what it
would have done"); maybe graduate to a slow per-`(project, workflow)`
prior later.

## Objective function

Optimize **expected cost-to-merge**, not raw tokens — where "cost" is a
two-vector of (dollars, quota-draw). The decision-theoretic cascade result
proves the trap: a cheap-first cascade always pays the cheap model's cost
before it can escalate, so on genuinely hard work cheap-first costs *more*
than starting strong (the operator's own framing: "fails review twice then
needs an Opus rescue"). That is exactly why the escape-hatch condition
matters — cheap-first is only correct where cheap-success is common, which
is the bounded loop roles and not the arbitrary default worker.

The free measurement that makes this real is **reviewer fix magnitude**: a
clean merge means the tier was right; a merge where the reviewer rewrote
half the diff means the worker was underpowered for that class, regardless
of attempt count. That single signal is both the de-escalation brake and
the ledger's reward, and it already exists in the merge path.

## Multi-model / multi-provider

Decouple **routing** (decide an abstract tier) from **resolution** (map
tier → concrete `{provider, model, env, sandboxDomains}`) via a named
**engine registry** mirroring the `claudeProfiles` two-table indirection.
Everything funnels through the one chokepoint,
`src/dashboard/claude-env.ts` (`claudeEnvPrefix`/`claudeEnvObject`), which
already feeds both the worker and headless launch paths.

- **Build-now (no protocol risk): Bedrock/Vertex running Anthropic
  models.** Same weights, same `rules.md` interpretation, same verdict
  vocabulary — only the billing/quota/auth path differs, via
  `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` which Claude Code
  already honors. This is the only thing that delivers true quota
  arbitrage (the heavy tier reroutes off a dry Anthropic `weekly` instead
  of pausing). Needs: the env vars at the chokepoint, the regional
  endpoints unioned into the sandbox allowlist, and a path around the
  OAuth-only `credentials.ts`.
- **Defer cross-family (OpenAI-compatible, Gemini, DeepSeek) for
  workers / resolvers / ci-fix.** Those agents must autonomously obey
  garden's protocol — the `.garden-done` sentinel (premature-done is
  already a live bug *on Anthropic models*), branch discipline, the
  verdict format. A different model family that misreads the protocol
  corrupts main via the autonomous force-push path. The reviewer's drift
  is contained (it is a gate); a worker's or resolver's drift is exposed.
  Cross-family is a research bet, not a v1 feature.
- **Two real blockers** for any non-first-party provider: `credentials.ts`
  is OAuth-only (refresh vs `platform.claude.com`, Keychain writeback),
  and the sandbox network allowlist is pinned to `*.anthropic.com`. Build
  the engine-registry seam; wire only Anthropic plus
  Bedrock/Vertex-Anthropic; leave the rest as a documented extension
  point.

## What to NOT build

- No trained classifier and no online contextual bandit — data too sparse,
  black-box, and a quality-optimizing router would happily burn Opus on
  trivia (violates goal one).
- No blocking Haiku triage call on the plant/respawn critical path — it
  taxes snappiness (a stated primary driver) and hits a rate-limited
  endpoint for a probabilistic, often-wrong signal.
- No a-priori triage on the default worker (no seed at plant; no loop to
  correct it).
- No cheapening of the default worker by default, and no cheapening of the
  resolver.
- No five-tier lattice, no per-worker engine overrides, no
  OpenAI-compatible workers in v1.
- No global all-projects pause on `weekly` exhaustion without a
  partial-degradation valve.

## Phased rollout

1. **Floors + make-status-quo-explicit.** `resolveModel(role, workflow,
   project, snapshot)` generalizing `resolveVineModel`; pin
   reviewer+resolver to Opus-never-fall-back; Haiku ineligible.
   Behavior-neutral; removes the silent account-default dependence. Ship
   first. Capture **reviewer-fix-magnitude** here too — it is the signal
   everything later learns from, and it is useful immediately as a
   read-only "which roles are underpowered" report.
2. **Cheapen the safe loop roles.** Grow → Sonnet; ci-fix →
   Sonnet-first/Opus-final — each with a real escalation signal wired
   (reviewer-fix-magnitude + CI). Guard the ci-fix corruption vector (a
   weak ci-fix that "fixes" red CI by weakening a test, then force-pushes):
   keep the final attempt on Opus and consider a "did it touch test
   files?" check.
3. **Effort axis** (if Claude Code exposes a launch-time knob): scale
   effort within tier. Cheapest win.
4. **Quota governor:** multi-bucket-aware, escalate-when-other-pool-flush,
   pause only when both dry, partial degradation, per-project config.
5. **Engine registry + Bedrock/Vertex-Anthropic** for true quota
   arbitrage; document cross-family as future.
6. **Ledger / observe mode** (reviewer-fix-magnitude): audit trail plus
   shadow recommendations. The bandit stays unbuilt until the data
   justifies it.

## Open questions

- **Effort at launch:** does Claude Code accept an effort setting at launch
  (env / settings.json / flag), or only via the interactive `/effort`?
  This decides whether L2 is a quick win or needs a harness change.
- **Reviewer-fix-magnitude capture:** worth wiring even before any routing
  change, as a read-only report, because it immediately tells the operator
  which roles are underpowered.
- **Cross-provider appetite:** is the near-term driver quota arbitrage
  (→ Bedrock/Vertex-Anthropic, build-now) or genuine model diversity
  (→ cross-family, deferred)? The answer scopes the engine registry.
