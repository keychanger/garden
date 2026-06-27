# Autonomy program: sequencing the future-docs into one path

> This document lives under `docs/future/` — it is a synthesis and program
> map over other speculative designs, not itself a spec or a committed
> plan. Workers must not act on it. Where it summarizes another doc, that
> doc is authoritative; where the two disagree, the other doc wins. See
> `rules.md` § Specifications and documentation.

## Status

Speculative — no code. This is a **north-star map**: it does not design new
machinery so much as place the existing `docs/future/` autonomy designs in
one prioritized sequence, name the few genuinely-new pieces that none of
them cover, and surface two architectural forks the corpus has not yet
resolved. It exists because garden accumulated a strong but scattered set
of autonomy designs independently, and a fresh end-to-end review kept
re-deriving them — the missing artifact was the connective tissue, not
more designs.

Detail for each slice lives in its owning doc (referenced inline and in the
table at the end). The only original design content here is in
§4 (Codex harness, the Advisor pattern) and §5 (the two forks).

## 1. The diagnosis: three ceilings, none of them execution

Garden's **execution loop is already at the frontier** and on the correct
side of the 2025-26 consensus: one writer per task in an isolated worktree,
an automated headless review → CI → resolve → merge gate, self-healing
failure agents, and cold-respawn loops that beat context rot. The field has
converged *against* naive parallel-writer multi-agent for coding; the
leverage is in the verification layer and in scaling effort to task value,
both of which garden already does. So the program below adds nothing to
execution. The ceilings are elsewhere:

1. **Work origination is almost entirely human.** The only machine-spawned
   worker today is holistic-review. There is no backlog, dependency graph,
   or ready-queue, so throughput is capped by operator typing speed, not
   worker count. (Owned by `PLAN-WORKFLOW.md` + `SPRIG.md`.)
2. **Model and harness utilization is an Opus monoculture.** Workers
   inherit the account default; nothing routes to Sonnet except trellis;
   the Codex subscription is unusable because no second harness is
   registered. The plumbing (opaque model strings end-to-end, the harness
   adapter registry) is built — only the policy and the Codex adapter were
   deferred. (Owned by `MODEL-SELECTION.md` + `MULTI-MODEL.md`.)
3. **The loop is open-loop with no admission control.** No throughput or
   quality telemetry to drive routing or prove gains; `newWorker()`
   dispatches unconditionally, so scaling just reaches the quota wall
   sooner. (Owned by `GASTOWN-LESSONS.md`.)

The quota fact that frames utilization, verified against `usage.ts`:
garden tracks three meters — `fiveHour` (5-hour rolling, **all models**),
`weekly` (all-models `seven_day`), and `sonnet` (`seven_day_sonnet`). On
Max plans `seven_day_opus` is null — **Opus rolls into the all-models
weekly**; there is no separate Opus pool. The auto-continue gate
(`poller-merge.ts`, `checkUsageThreshold`) watches `fiveHour` + `weekly`
and **deliberately excludes the Sonnet meter** (`filter(m => m.key !==
"sonnet")`, "the operator runs Opus, sonnet quota is abundant"). So the
binding constraint is the all-models weekly + the shared 5-hour window;
the dedicated Sonnet weekly bucket sits idle. Moving loop-bounded work to
Sonnet taps that idle bucket and keeps scarce Opus for the review gate.
(This is the same three-bucket reality `MODEL-SELECTION.md` constraint 4
records.)

## 2. What already exists (the corpus is the answer to "what are we missing?")

The honest answer to "what are we missing" is **not designs** — it is a
sequence, two decisions, and two net-new pieces. The autonomy ladder maps
almost entirely onto docs that already exist:

| Program slice | Owning design doc | Status |
|---|---|---|
| Telemetry / metrics layer (JSONL events + `garden stats`) | `GASTOWN-LESSONS.md` (A3) | speculative, authoritative |
| Concurrency / capacity scheduler (admission control on spawn) | `GASTOWN-LESSONS.md` (B1) | speculative, authoritative |
| Stalled-worker detection + `garden escalate` verb | `GASTOWN-LESSONS.md` (A1, A2) | speculative, authoritative |
| Machine-checked `done` (fix premature `.garden-done`) | `SPRIG.md` (its Phase 4, called out as independently worth fixing) | speculative |
| Backlog **producer**: intent → dependency graph | `PLAN-WORKFLOW.md` | speculative, authoritative |
| Idle-quota **work generator** (operator-curated, risk-tiered) | `SPRIG.md` | speculative, authoritative |
| Automatic model router (tier/effort/provider) | `MODEL-SELECTION.md` | speculative, authoritative |
| Per-project model pins + hardening/hygiene passes | `PROJECT-CUSTOMIZATION.md` | speculative, authoritative |
| Deferred / cross-horizon coherence review | `SCHEDULED-HORIZON-REVIEW.md` | speculative, authoritative |
| Design-mode authoring workflow (spec → handoff) | `BOTANIST-WORKFLOW.md` | speculative, authoritative |
| Multi-model / harness substrate (provider layer shipped) | `MULTI-MODEL.md` | Phases 1-3 shipped |

Two consequences worth stating plainly:

- The **autonomous asking/failing resolution** and the **bisecting
  merge queue** items a naive roadmap would add are *deliberately not* in
  the corpus. `GASTOWN-LESSONS.md` makes the bisecting merge queue an
  explicit non-goal ("the bottleneck is review quality, not throughput")
  — that judgment stands; do not build it. Autonomous `asking`/`failing`
  resolution is genuinely undesigned and is the one origination-side gap
  the corpus leaves open (see §6).
- The corpus is **internally split** on two load-bearing questions (§5).
  Those forks, not missing designs, are what block the backlog and router
  work.

## 3. Sequencing: telemetry and the scheduler are the floor

The corpus designs are mostly independent of one another, which hides a
dependency the program must respect: **the router and the backlog both
assume measurement and admission control that nothing builds first.**

- `MODEL-SELECTION.md`'s router routes on **reviewer-fix-magnitude** (the
  un-launderable underpower signal) and an observe-only ledger — i.e. it
  needs the telemetry layer (`GASTOWN-LESSONS.md` A3) to exist before it
  can make or justify a single routing decision.
- `PLAN-WORKFLOW.md` and `SPRIG.md` both dispatch workers from a queue.
  Draining a queue without the capacity governor (`GASTOWN-LESSONS.md` B1)
  just reaches the quota wall faster and parks the fleet together — the
  exact failure the governor exists to prevent.

So the sequence is: **measurement and admission control first, then
utilization policy, then origination, then the second harness.** Concretely:

1. **Now — close the loop and make autonomy safe.**
   (a) Telemetry layer (`GASTOWN-LESSONS.md` A3), with reviewer-fix-magnitude
   captured even before any routing change — `MODEL-SELECTION.md` flags this
   as "the signal everything later learns from."
   (b) Capacity/admission scheduler (`GASTOWN-LESSONS.md` B1), cap dispatch
   against **reviewer (Opus) headroom**, not just worker count.
   (c) Machine-checked `done` (`SPRIG.md` Phase 4) — premature `.garden-done`
   is a real current bug, and you cannot trust autonomy you cannot trust to
   *stop*.
2. **Next — utilization policy.** The model router (`MODEL-SELECTION.md`),
   now that telemetry can drive escalate/de-escalate. Resolve fork #2 (§5)
   first.
3. **Next — origination.** The backlog producer (`PLAN-WORKFLOW.md`) and the
   idle-quota generator (`SPRIG.md`), draining through the scheduler from #1.
   Resolve fork #1 (§5) first.
4. **Next — second harness.** The Codex adapter (§4), once the Claude-only
   fleet runs on telemetry + scheduler + router.
5. **Later — coherence at scale.** Deferred horizon review
   (`SCHEDULED-HORIZON-REVIEW.md`) and a cross-worker integration check, which
   matter only once many workers routinely land in one project.

## 4. Net-new: the two pieces the corpus does not cover

### 4a. Codex as a second harness (the one deliberate reversal)

`GASTOWN-LESSONS.md` (D3) skips multi-runtime/Codex "until Claude is
genuinely insufficient." That rationale is now superseded by a different
driver: the operator pays for a Codex subscription whose capacity is a
**separate quota pool** touching neither Claude bucket, and wants to use it.
The goal is not "Claude is insufficient" — it is "spend idle paid capacity
and gain a genuine cross-model reviewer." That is a new input, so the
deferral should be revisited, not treated as settled.

Feasibility is verified against OpenAI's Codex docs and is green, with one
sharp caveat:

- **Codex satisfies garden's hard registration gate.** `codex exec --json`
  emits a native `turn.completed` event (with a token-usage object) at the
  end of every turn — a clean inline turn-end signal, so
  `HarnessCapabilities.turnEnd` can be `true`. There is **no per-tool hook
  firehose**; the adapter consumes the JSONL event stream instead, which is
  *less* load than Claude's hook model (a snappiness win).
- **It maps cleanly to the adapter interface.**
  `codex exec --json --sandbox workspace-write -a never -C <worktree>` is
  the `claude -p` analog; rollout JSONL under `~/.codex/sessions/` is the
  transcript source; `codex exec resume <id>/--last` is the resume
  primitive; the transient-error matcher must split generic `rate_limit`
  (retry) from `usage_limit_reached` (quota window exhausted).
- **Caveat — macOS self-push is blocked by default.** In `workspace-write`
  the sandbox disables network, and on macOS the Seatbelt sandbox
  *silently ignores* `network_access=true` (openai/codex #10390, #13373).
  An autonomous self-pushing Codex worker on a Mac likely needs
  `--sandbox danger-full-access`, or push outside the agent. Also do not
  rely on `--output-schema` (broken when MCP tools are active, which can
  also degrade the `--json` stream).
- **De-risk by piloting Codex on a single-shot headless role first**
  (ci-fix or resolver). That sidesteps the interactive turn-end dependency,
  is low-stakes, and still exercises the full `HarnessCore` dialect before
  any interactive worker.
- **Cross-model review is nearly free once a Codex worker lands.** Garden's
  reviewer is already harness- and provider-independent (`reviewerEnvPrefix`
  empties inherited env, Opus-pinned), so "Codex writes / Claude Opus
  reviews" is the default. Add the reciprocal (a rotating Codex
  second-opinion on high-risk Claude diffs) to break the Opus-reviews-Opus
  monoculture.

Net-new interface work the registry does not yet have: a `--harness` flag /
`garden config <project> harness` key (no operator surface exists today),
and a `recoverSessionId(entry)` method on `HarnessCore` (Codex self-assigns
session ids; the shipped interface only has `allocateSessionId()`). The full
adapter (`codex-core.ts` + `codex.ts`, registered in both `core.ts` and
`index.ts`) is the `MULTI-MODEL.md` Layer-3 design target, still at zero code.

### 4b. The Advisor pattern resolves the model-router's central tension

`MODEL-SELECTION.md`'s sharpest constraint is that the **default worker must
stay Opus**: it has no cold-respawn escape hatch and no seed text at the
plant point, so a misrouted default worker to Sonnet-alone cannot recover.
That is correct and it is why "pin everything to Sonnet" is wrong.

Anthropic's **Advisor tool** dissolves the tension. A Sonnet (or Haiku) main
model consults an Opus advisor at decision points it chooses; Anthropic's
own benchmark has **Sonnet + Opus-advisor beating Sonnet-alone by +2.7pp on
SWE-bench Multilingual while cutting cost-per-task 11.9%.** It self-escalates
with no orchestration logic and no cold-respawn boundary — exactly the
"recover from a misroute without a loop" property the default worker lacks.
So a default worker can run **Sonnet + Opus-advisor** instead of Opus-alone:
near-Opus quality, a sliver of the Opus bucket, and safe even without an
escape hatch.

It is one config line (`advisorModel: opus` / `--advisor opus`, Claude Code
v2.1.98+), works on subscription accounts hitting `api.anthropic.com`, and
the advisor must be at least as capable as the main model. **Constraint:**
Anthropic-API only — not Bedrock/Vertex/Foundry or non-Anthropic providers,
so gate it on `provider === anthropic`, mirroring how the reviewer is
already pinned. This belongs in `MODEL-SELECTION.md`'s resolver as a new L-layer
option (Sonnet-main + Opus-advisor as the default-worker default on
Anthropic projects); it is recorded here because that doc predates the tool.

The other near-free utilization levers, available today with no code:
keep the reviewer Opus-pinned (already is); move **loop-bounded** roles
(grow, ci-fix, trellis vine) to Sonnet — which `MODEL-SELECTION.md` already
sanctions because their loops catch a misroute; and dial routine
grow/hardening passes to `effort: medium`.

## 5. The two forks the operator must resolve

These are not missing designs — they are unresolved disagreements *within*
the corpus that block downstream work until decided.

### Fork 1 — the backlog substrate: beads (`bd`) vs an owned flat store

- `PLAN-WORKFLOW.md` adopts **beads** as the work-graph substrate: it sets
  `BEADS_DIR=~/.beads/` in every worker and emits `bd create` / `bd dep add`
  to build a dependency-aware graph.
- `SPRIG.md` deliberately uses a **flat, regex-parsed `.garden/sprigs.md`**
  with no schema or dependency edges, cutting graph machinery "ahead of
  evidence."
- `GASTOWN-LESSONS.md` explicitly **skips Beads/Dolt** as a backing store,
  citing the owned-foundation memory.

These are partly reconcilable: `bd` is a single static Go binary an agent
shells out to for the *project work graph*, which is distinct from taking
Dolt as garden's *own* state store (the thing GASTOWN-LESSONS rejects).
Independent research on beads supports a middle path: the transferable idea
is the **deterministic "ready" set computed by the orchestrator, not the
LLM** (`blocks` + parent edges, atomic claim, JSONL-in-git) — the model of
*Beads Classic*, before its 1.x move to Dolt for multi-machine scale that it
had to partially walk back. The fork to decide: **adopt the `bd` CLI as the
work-graph substrate (PLAN-WORKFLOW's bet) or build the owned, flat/JSONL
ready-queue (SPRIG's bet, dependency-light, single-writer poller).** A
single-writer poller draining an owned JSONL store structurally avoids the
merge-conflict failure mode that still dogs beads — but `bd` is built,
agent-legible, and PLAN-WORKFLOW already designed around it. This decision
gates the entire origination layer; it should be made before either ships.

### Fork 2 — the default worker's model

- A naive "use Sonnet everywhere" pins the **default** worker to Sonnet —
  which `MODEL-SELECTION.md` constraints 1-2 show is unsafe (no escape
  hatch, no seed).
- The resolution proposed in §4b: run the default worker as **Sonnet +
  Opus-advisor** on Anthropic projects (safe, cheap, self-escalating),
  keep loop-bounded roles on plain Sonnet, keep the reviewer on Opus.
- The conservative fallback: leave the default worker on Opus and only
  cheapen loop roles (what `MODEL-SELECTION.md` sanctions today).

Deciding this unblocks the router (`MODEL-SELECTION.md`) and most of the
Phase-0 utilization win.

## 6. Genuinely open (undesigned in the corpus)

- **Autonomous `asking`/`failing` resolution.** As worker count rises, these
  per-worker human-interrupt streams become the new ceiling. No doc designs
  auto-retry-with-escalation for `failing` or bounded auto-approval +
  timeout-escalation for `asking`. `GASTOWN-LESSONS.md`'s `escalate` verb is
  the nearest primitive (worker-emits-signal), not auto-resolution.
- **Cross-worker integration gate.** Holistic review covers one worker's own
  cumulative diff; `SCHEDULED-HORIZON-REVIEW.md` covers deferred drift. The
  combined diff of *concurrently-merged, file-overlapping siblings* — the
  defect class that grows precisely when more parallel workers land — has no
  gate. The post-merge sibling-overlap set already computed in
  `poller-merge.ts` is the natural trigger.
- **`docs/README.md` index gap (mechanical):** `BOTANIST-WORKFLOW.md` exists
  on disk but is absent from the index table; this doc adds both rows.

## 7. References

| Doc | Owns |
|---|---|
| `docs/future/GASTOWN-LESSONS.md` | telemetry/`garden stats`, capacity scheduler, stalled detection, escalate verb; bisecting-merge-queue non-goal |
| `docs/future/MODEL-SELECTION.md` | the model/tier/effort/provider router; measurement-not-prediction; escalate-safe asymmetry; three-bucket quota constraint |
| `docs/future/PLAN-WORKFLOW.md` | intent → dependency graph (the backlog producer, beads-based) |
| `docs/future/SPRIG.md` | idle-quota work generator; operator-curated flat backlog; risk tiers; premature-`.garden-done` fix |
| `docs/future/PROJECT-CUSTOMIZATION.md` | per-project model pins, hardening passes, hygiene/`garden health` diagnostic |
| `docs/future/SCHEDULED-HORIZON-REVIEW.md` | deferred cross-horizon drift review |
| `docs/future/BOTANIST-WORKFLOW.md` | design-mode authoring workflow (spec → handoff) |
| `docs/MULTI-MODEL.md` | provider layer (shipped) + harness adapter registry (Codex = Layer-3 target) |
| `docs/STATUS.md` | worker status state machine, no-polling invariant |
