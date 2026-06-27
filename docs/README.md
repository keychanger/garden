# docs/

Design docs and behavioral specs for garden. Top-level entry-point docs
(`CLAUDE.md`, `DESIGN.md`, `WORKFLOWS.md`, `rules.md`) stay at the repo
root; this directory holds the rest.

Three kinds of doc live here:

- **Specs** — authoritative behavioral contracts. Open with the marker
  phrase *"if the code disagrees with this document, the code is wrong"*
  in the first paragraph. The reviewer treats them as source of truth and
  refuses to edit them to match the code; if the code disagrees, fix the
  code.
- **Design docs / plans for in-progress work** — forward-looking
  architecture for work that has at least one phase shipped or actively
  in flight. Authoritative for the design intent, not for the code yet.
- **Speculative designs and analyses** — anything not yet implemented, or
  external-codebase comparisons. These live under `docs/future/` so the
  path itself signals "do not act on this." Workers must not treat
  anything under `docs/future/` as a contract — see `rules.md`
  § Specifications and documentation.

Once a design doc's work ships, its content typically folds into the
relevant authoritative doc (`WORKFLOWS.md`, `DESIGN.md`, or a sibling spec)
and the original may be deleted or kept as historical record. When a
`docs/future/` doc graduates to in-progress work, move it up to `docs/`.

## Index

| Doc | Kind | Subject |
|---|---|---|
| [STATUS.md](STATUS.md) | spec | Worker status state machine — display states, detection machinery, transition invariants |
| [MULTI-MODEL.md](MULTI-MODEL.md) | design | Multi-model / multi-harness architecture. Phase 1 (provider layer: `garden provider`, worker env swap, reviewer pinning) shipped; harness adapters (Phases 2-5) are design targets. |
| [TRACKS.md](TRACKS.md) | spec (design target) | Multi-track projects and the promotion pipeline. No code yet. |
| [TRELLIS-PLAN.md](TRELLIS-PLAN.md) | design | Phased implementation plan for the trellis workflow. The trellis spec itself lives in `WORKFLOWS.md` § "Trellis workflow"; this doc is the plan that produced it. |
| [future/AUTONOMY-PROGRAM.md](future/AUTONOMY-PROGRAM.md) | speculative | North-star map sequencing the autonomy future-docs into one program: the three ceilings (origination, model/harness utilization, open-loop), which existing doc owns each slice, the telemetry-and-scheduler-first ordering, two net-new pieces (Codex second harness, the Advisor pattern), and two unresolved forks (backlog substrate; default-worker model). No code today. |
| [future/PLAN-WORKFLOW.md](future/PLAN-WORKFLOW.md) | speculative | The plan workflow: convert human-described features into a beads graph for autonomous execution. No code today — workers must not run `bd` commands or file beads. |
| [future/BOTANIST-WORKFLOW.md](future/BOTANIST-WORKFLOW.md) | speculative | The botanist workflow: a design-mode authoring workflow whose output is a design artifact (a trellis/spec) rather than a commit; operator approves, then hands off to an implementing worker. No code today. |
| [future/GASTOWN-LESSONS.md](future/GASTOWN-LESSONS.md) | speculative | External-codebase analysis of `gastownhall/gastown` with a phased roadmap of borrowed primitives. Bead references describe gastown, not garden. |
| [future/PROJECT-CUSTOMIZATION.md](future/PROJECT-CUSTOMIZATION.md) | speculative | Brainstorm for expanding per-project (and possibly per-plot) customization: new config knobs, project-scoped skills and review rules, hardening passes, hygiene evaluator, and setup wizard. No code today. |
| [future/SPRIG.md](future/SPRIG.md) | speculative | Sprig: latent self-improvement on idle quota — operator-curated per-project backlog planted as grow workers, reviewer-enforced risk tiers, default-off surplus autoplant. No code today. |
| [future/MODEL-SELECTION.md](future/MODEL-SELECTION.md) | speculative | Automating model selection (Opus/Sonnet/Haiku + effort + provider): the measurement-not-prediction reframe, five code constraints, the escalate-safe/de-escalate-conservative asymmetry, a layered resolver, and Bedrock/Vertex-first multi-provider. No code today beyond trellis's `resolveVineModel`. |
| [future/DESKTOP-NOTIFICATIONS.md](future/DESKTOP-NOTIFICATIONS.md) | speculative | Native macOS banners/sound when a worker finishes or gets stuck, riding the existing `transitionState` and `addAlert` chokepoints; plus a heavier menu-bar-app track. No code today (`garden notify`, `notify` config, `notify.ts` do not exist). |
| [future/SCHEDULED-HORIZON-REVIEW.md](future/SCHEDULED-HORIZON-REVIEW.md) | speculative | A deferred review that wakes a fresh worker days after a multi-phase merge to check whether a recorded decision drifted, using accumulated git/CI/sibling history. The longer-horizon sibling of the merge-time holistic review; gated on a pre-registered revisit hypothesis so it verifies rather than fishes. No code today. |

## Adding a new doc

New design docs and specs go in this directory directly (flat layout
until ~10 files; subdivide later). Speculative designs and external-
codebase analyses go under `docs/future/` instead — the path itself
signals "do not act on this." Filename in `UPPER-KEBAB-CASE.md`
matching the existing convention.

If the doc is a behavioral spec, open with the marker phrase. If it's
a forward-looking design, say so explicitly in a "Status" section near
the top. Either way, add a row to the index table above.
