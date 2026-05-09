# Tracks and Promotion

Spec for multi-track projects and the promotion pipeline. This document
is the source of truth for how tracks work. **If the code disagrees with
this document, the code is wrong.** Tracks generalize the current
one-`baseBranch`-per-project model into a named set of branches per
project with explicit promotion relationships; every existing project is
expressible as a single-track project, and the backward-compatibility
desugaring below must be preserved.

## Model

A **track** is a named branch on a project, targeted by workers and the
poller. A project has one or more tracks. Exactly one track per project
is marked `default`.

A track optionally declares `promotesTo`, naming another track on the
same project. This forms a DAG — in practice a linear chain, e.g.
`lab → staging → main`. A track with no `promotesTo` is **terminal**.
Terminal tracks are the final merge targets (typically `main`); upstream
tracks feed into them via promotion.

Workers are spawned against a specific track. `WorkerEntry.baseBranch`
already pins the base at worker creation and is the authoritative
per-worker target; tracks do not change that contract — they only change
the set of legal bases a worker may pin.

## Config schema

```yaml
projects:
  garden:
    path: ~/code/keychange/garden
    tracks:
      main:
        base: main
        default: true
      lab:
        base: lab
        promotesTo: main
        autoRebase: true
        reviewProfile: relaxed
```

Fields per track:

| Field           | Required | Default   | Meaning                                                                          |
|-----------------|----------|-----------|----------------------------------------------------------------------------------|
| `base`          | yes      | —         | Git branch name on origin.                                                       |
| `default`       | no       | false     | Exactly one track per project must be true.                                      |
| `promotesTo`    | no       | —         | Another track name on the same project. Omitted means terminal.                  |
| `autoRebase`    | no       | false     | When `promotesTo` advances, auto-rebase this track onto it.                      |
| `reviewProfile` | no       | `default` | One of `strict \| default \| relaxed`. Maps to a prompt template in `prompts.ts`.|
| `resetOnPromote`| no       | true      | After a successful promotion, reset this track's base to the new target head.    |

### Backward compatibility

A project with `baseBranch: X` and no `tracks` key desugars at read time to:

```yaml
tracks:
  main:
    base: X
    default: true
```

The track name is literally `main` regardless of the branch name. Reads
accept both forms; writes produced by garden commands use the new form.
Existing configs keep working without edits.

## Worker spawn

Worker spawn takes an optional track. If omitted, the project's default
track is used.

- `⌥n` — spawn into default track.
- `⌥⇧n` — prompt for track selection from the project's tracks.
- CLI: `garden workers new <project> [--track <name>]`.

The resolved track's `base` is fetched and pinned to
`WorkerEntry.baseBranch` exactly as today. A base not present on origin
is rejected up front (same validation as today).

Workers on different tracks within the same project share the project's
sandbox config, `checks`, `postMerge`, and `claudeProfile`. None of
those are per-track in v1.

## Promotion

```
garden promote <project> [<track>]
```

Promotes the named track's HEAD to its `promotesTo` target. If
`<track>` is omitted, promotes the unique track whose `promotesTo` is
the project's default track; errors if the set of such tracks is empty
or ambiguous.

The pipeline reuses the existing reviewer/resolver/merge-queue
machinery, retargeted from a worker's own branch to the source track's
base:

1. Fetch origin.
2. In a throwaway worktree, rebase the source track's base onto the
   target track's base.
3. Run the project's `checks` command.
4. Launch a reviewer using the **target track's** `reviewProfile`
   prompt. The reviewer sees the full diff of source-vs-target.
5. On pass: force-push source to its own base branch (so the rebased
   history is durable), then fast-forward target's base via a direct
   refspec push.
6. Post-merge: fast-forward the local checkout of target's base and run
   `postMerge`.
7. If `resetOnPromote` is true for the source track, reset source's
   base to the new target head (clean slate for the next cycle).

Each step is an existing code path invoked with different arguments. No
new pipeline. Failures surface through the existing alerts subsystem
with source `promote` and the track name in the message.

## Cross-track rules

- **Conflict notifications** fire within a track only. Workers on track
  A are not notified when track B merges. Exception: after a successful
  promotion, workers on the *target* track are notified (their base has
  advanced).
- **Auto-rebase**, if enabled on a track, runs when the track's
  `promotesTo` target advances — triggered via the same poker FIFO the
  poller already uses. Reuses the resolver, with the same retry budget
  as worker resolves. Failure raises an alert (source `track-rebase`).
- **Review profiles** do not inherit across tracks. A worker on the lab
  track is reviewed with lab's profile; a promotion from lab to main is
  reviewed with main's profile.

## Dashboard surface

The status pane renders `(project, track)` pairs as sub-rows under a
single project header. Render order: default track first, others below.
The track name appears in the row label (e.g. `garden/lab`).

Project color from the 9-color palette is shared across a project's
tracks — tracks do not consume palette slots. Track identity is carried
in the label, not the color.

Alerts include the track name when relevant, e.g.
`lab: base origin/lab deleted upstream`.

## Edge cases

- **Base deleted upstream.** Poller raises an alert (source `track`,
  unread badge). Workers on the track continue to exist but cannot
  merge. `garden tracks doctor` offers reset / remap / delete.
- **`promotesTo` cycle.** Config load rejects with a clear error.
  Garden refuses to start until fixed.
- **Default track removal.** Rejected at config write time unless
  another track is simultaneously marked default in the same write.
- **Track with no workers.** Fine — tracks exist independently of
  workers. A track with no workers is still promotable if its base has
  commits ahead of the target.
- **Promotion race.** Target track's base advances during a promote.
  The pipeline's rebase step handles this exactly as today — the
  resolver kicks in. Retry budget matches worker resolves.
- **Worker on a non-default track whose config is removed.** Worker's
  pinned `baseBranch` still resolves (it's a real branch), but new
  spawns into the removed track fail. Existing workers complete or are
  killed normally.

## Commands

New:

- `garden promote <project> [<track>]` — promote a track.
- `garden tracks list <project>` — show tracks, their bases, promotion
  chain, ahead/behind counts.
- `garden tracks add <project> <name> --base <branch> [--promotes-to <track>] [--review-profile <profile>] [--auto-rebase]`
- `garden tracks remove <project> <name>` — refuses while workers are
  pinned to the track.
- `garden tracks doctor <project>` — validate track state against
  origin; offer fixes for drift.

Existing `garden workers new` gains an optional `--track <name>`. No
existing flag changes meaning.

## Not in scope for v1

- Multi-parent promotion DAGs. A track has at most one `promotesTo`.
- Track renaming. Workflow: add new, remove old, respawn workers.
- Per-track `checks`, `postMerge`, `sandboxDomains`, or
  `claudeProfile`. All inherit from the project.
- `garden tracks stash` for mid-experiment context switching. Add only
  if the single-lab-at-a-time constraint bites in practice.
- A reserved "lab" convention baked into garden itself. v1 ships the
  primitive; the lab playbook is documentation, not code.
- Parallel garden binary (`glab`) with isolated `~/.garden-lab/` state.
  Orthogonal concern, layered on top of tracks later.
