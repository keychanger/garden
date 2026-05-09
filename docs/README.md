# docs/

Design docs and behavioral specs for garden. Top-level entry-point docs
(`CLAUDE.md`, `DESIGN.md`, `WORKFLOWS.md`, `rules.md`) stay at the repo
root; this directory holds the rest.

Two kinds of doc live here:

- **Specs** — authoritative behavioral contracts. Open with the marker
  phrase *"if the code disagrees with this document, the code is wrong"*
  in the first paragraph. The reviewer treats them as source of truth and
  refuses to edit them to match the code; if the code disagrees, fix the
  code.
- **Design docs / plans** — forward-looking architecture for not-yet-shipped
  or in-progress work. Authoritative for the design intent, not for the
  code (since the code may not exist yet).

Once a design doc's work ships, its content typically folds into the
relevant authoritative doc (`WORKFLOWS.md`, `DESIGN.md`, or a sibling spec)
and the original may be deleted or kept as historical record.

## Index

| Doc | Kind | Subject |
|---|---|---|
| [STATUS.md](STATUS.md) | spec | Worker status state machine — display states, detection machinery, transition invariants |
| [TRACKS.md](TRACKS.md) | spec (design target) | Multi-track projects and the promotion pipeline. No code yet. |
| [TRELLIS-PLAN.md](TRELLIS-PLAN.md) | design | Phased implementation plan for the trellis workflow. The trellis spec itself lives in `WORKFLOWS.md` § "Trellis workflow"; this doc is the plan that produced it. |
| [PLAN-WORKFLOW.md](PLAN-WORKFLOW.md) | design | The plan workflow: convert human-described features into a beads graph for autonomous execution. Folds into `WORKFLOWS.md` § "Plan workflow" once Phase 1 ships. |
| [GASTOWN-LESSONS.md](GASTOWN-LESSONS.md) | analysis | External-codebase analysis of `gastownhall/gastown` with a phased roadmap of borrowed primitives. Not a committed plan. |

## Adding a new doc

New design docs and specs go in this directory directly (flat layout
until ~10 files; subdivide later). Filename in `UPPER-KEBAB-CASE.md`
matching the existing convention.

If the doc is a behavioral spec, open with the marker phrase. If it's
a forward-looking design, say so explicitly in a "Status" section near
the top. Either way, add a row to the index table above.
