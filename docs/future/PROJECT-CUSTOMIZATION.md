# Project Customization

> This document lives under `docs/future/` — it describes unshipped
> designs and an open brainstorm. Workers must not act on it as a spec
> (no new config keys, no new workflows, no setup wizard). See
> `rules.md` § Specifications and documentation.

Brainstorming doc for expanding per-project (and possibly per-plot)
expressiveness in garden. Captures the analysis behind a deep-dive
conversation: what we can customize today, where the surface is too
thin, and three larger directions that fall out of the same gap —
specialized hardening passes, a project-hygiene evaluator, and a
project-setup wizard.

The shape of this document is a brainstorm, not a plan. It lists ideas
ranked by leverage, names trade-offs explicitly, and flags open
questions. None of it is committed. Phasing at the end is a
suggestion, not a sequence.

## Status

- Speculative. No code, no CLI surface, no `WorkflowDefinition` yet.
- Triggered by the observation that the per-project surface in
  `~/.garden/config.yml` is mostly "where files live" and "what
  commands to run" — most behavioral choices (reviewer prompt,
  worker/reviewer model, sandbox write paths, bundled skills) are
  hard-coded across all projects.
- The three large threads (hardening passes, hygiene, wizard) emerged
  in the same conversation because they all share the same root: there
  is no place today for *project-specific operational behavior*
  beyond the YAML config and `<project>/.garden/rules.md`.

## Intent

Garden currently treats projects as nearly fungible. The differences
between `garden`, `lex`, and `well` in `~/.garden/config.yml` are a
shell command (`checks`), an optional `postMerge`, an optional Claude
profile, and a log color. The system prompt every worker sees is
~95% the same across all projects; the reviewer prompt is ~100% the
same. The bundled skills are identical.

This regularity is mostly fine. Most projects do not need a custom
postMerge or a custom sandbox config. But it bottoms out at a hard
ceiling: there is **no per-project place to say** *"in this codebase,
the reviewer should also flag inline TODOs"*, or *"this worker should
have a `deploy-preview` skill"*, or *"a security pass on this project
means running these specific checks and looking at these specific
files."*

The intent of the work this document brainstorms is to **widen the
per-project surface in three orthogonal ways**:

1. **Declarative** — more config keys (model preferences, sandbox
   write paths, base branch, review timeout, auto-continue policy).
2. **Prose** — new project-rooted files that ride along with workers
   and reviewers (`review-rules.md`, project-scoped skills).
3. **Episodic** — operations garden runs *on* a project on a cadence
   (hardening passes, hygiene checks, setup wizard).

Each axis answers a different "where does this customization live?"
question. Today only the declarative axis is real, and only at the
flat YAML level.

## Current state (summary)

Catalog of the existing customization surface, recapped here so the
gaps in later sections are concrete:

### Per-project

| Key | Where it lives | Effect |
|---|---|---|
| `path` | `config.yml` | filesystem location |
| `checks` | `config.yml` | CI-equivalent command; worker prompt + reviewer |
| `postMerge` | `config.yml` | shell command after merge |
| `sandboxDomains` | `config.yml` | extra network allowlist hosts |
| `claudeProfile` | `config.yml` | separate `CLAUDE_CONFIG_DIR` |
| `logColor` | `config.yml` | dashboard log color |
| `trellisDir`, `maxTrellisIterations`, `trellisOpusFallback`, `maxGrowIterations` | `config.yml` | workflow defaults |
| `<project>/.garden/rules.md` | filesystem | appended after global rules in both worker prompt and reviewer |

### Per-plot

```ts
interface PlotConfig {
  projects: string[];   // ordered, max 9
  focused?: boolean;    // in ⌥p cycle or not
}
```

Plots are *purely a dashboard view*. No plot-scoped behavior anywhere
in the codebase. `resolvePlotStatus` (`src/dashboard/plot-status.ts`)
only aggregates worker states for the strip icon.

### Per-worker / per-workflow (for context)

Workflow chosen at plant-time. `WorkflowDefinition` is code, not config
— it carries `validTransitions`, `stateHandlers`, `hookHandlers`,
optional `workerModel`/`reviewerModel`. Per-worker `--model`,
`--max-iterations`, `--seed`/`--trellis` flags override.

### Hard-coded across all projects

- Reviewer prompt sections (`src/dashboard/prompts.ts`).
- Worker/reviewer model defaults (account default).
- Sandbox write paths (`src/dashboard/sandbox.ts` —
  `DEFAULT_ALLOW_WRITE` is a literal).
- Bundled skills (`src/dashboard/skills.ts` — fixed four: `done`,
  `handoff`, `trellis-author`, `grow`).
- Base branch resolution (reads project checkout's current branch).
- Review timeout (30 min, `REVIEW_TIMEOUT_MS`).
- Auto-continue gate (top-level only, not per-project).
- Worker name theme, spec sentinel string, doc-discovery patterns.

## Axis 1 — Declarative

New config keys. The cost is low (one optional field plus a fallback
chain); the value is linear. Ranked.

### A1.1. `workerModel` and `reviewerModel`

```yaml
projects:
  omi-godot:
    workerModel: sonnet
    reviewerModel: sonnet
  garden:
    reviewerModel: opus       # already the trellis default for vines
```

Resolution: per-worker override → workflow pin → project default →
account default. The plumbing already exists for the workflow-pin
case (`trellis-model.ts`); extending it is mechanical.

**Leverage:** real cost savings. Haiku 4.5 at ~$0.80/Mtok can run
reviews for static frontends and Godot projects. Opus stays where it
earns its tokens.

### A1.2. `sandboxAllowWrite`

```yaml
projects:
  rust-thing:
    sandboxAllowWrite: ["~/.cargo"]
  godot-thing:
    sandboxAllowWrite: ["~/.local/share/godot"]
```

Mirrors `sandboxDomains` exactly. `src/dashboard/sandbox.ts:48-70` is
already shaped to absorb this — one extra `for` loop. Today only the
network allowlist is extensible per project; the filesystem allowlist
is global.

**Leverage:** unblocks Rust, Bun, Godot, anything with a per-tool
cache outside `~/.npm` and `~/.cache`. Without this, workers in those
ecosystems hit silent sandbox denials.

### A1.3. `baseBranch`

```yaml
projects:
  some-product:
    baseBranch: develop
```

Today `resolveBaseBranch(project.path)` reads the project checkout's
current branch — fragile if the checkout is parked on a feature.
A per-project pin makes the base authoritative.

### A1.4. `reviewTimeoutMinutes`

`REVIEW_TIMEOUT_MS = 30 * 60 * 1000` is global. Projects with slow
test suites (`lex-benchmarks` already pays the cost on the worker side
with `--test-timeout=60000` in its `checks`) want the reviewer to have
the same slack.

### A1.5. Per-project `autoContinue`

`autoContinue` lives at the top of `config.yml` only. A per-project
override (boolean, or threshold) lets stable side-projects auto-stop
after first merge instead of advancing into a "next phase" the
operator does not have in mind.

### A1.6. `defaultWorkflow`

```yaml
projects:
  stable-product:
    defaultWorkflow: grow
```

Newly-planted workers in this project default to grow loops (bounded
polish) instead of default (open-ended). Useful when most work on a
project is hardening rather than greenfield.

### A1.7. Plot inheritance for the obvious values

```yaml
plots:
  imp:
    projects: [lex, lex-benchmarks, lex-frontend, website]
    claudeProfile: imp     # all four inherit
    workerModel: sonnet    # all four inherit
```

Resolution: project value wins, otherwise plot value of the first plot
containing the project, otherwise default.

**Caveat:** worth doing **only after several inheritable values
exist**. With `claudeProfile` alone, the user sets it once per project
at `garden add` time and is done — no real itch. With three or four
inheritable values (profile, models, default workflow,
auto-continue), the matrix gets tedious enough that inheritance
earns its complexity.

Sequencing recommendation: ship the project-level values first.
Promote to plot inheritance once the matrix is clearly demanding it.

## Axis 2 — Prose

Files that ride along with the project and are loaded into the worker's
or reviewer's context. Higher leverage than YAML because the *content*
is unconstrained — prose says things YAML cannot.

### A2.1. Project-scoped skills

```
<project>/.garden/skills/<name>/SKILL.md
```

`installClaudeSkills` (`src/dashboard/skills.ts:355`) currently writes
the four bundled skills into every worker's `.claude/skills/` at
worktree bootstrap. Extend it to also walk
`<project>/.garden/skills/` and copy every directory beneath it.

**Why this is the single best change.** Skill descriptions are
Claude's strongest trigger mechanism — they fire at planning time,
not after the prompt is composed. A project that ships a
`deploy-preview`, `db-migrate`, `screenshot-check`, `linkcheck`, or
`cve-lookup` skill effectively grants every worker in that project a
new ability without any per-worker prompt engineering. Cost: ~30 lines
in `skills.ts`. Value: a new category of customization (not a
parameterization of an existing one).

This also composes with hardening passes (Axis 3) — a security pass
workflow can bundle additional security-flavored skills on top of the
project's own.

### A2.2. Project review rules

```
<project>/.garden/review-rules.md
```

A new `reviewExtraInstructionsSection` in `reviewSections`
(`src/dashboard/prompts.ts:189-203`) renders this file if present.

Today the reviewer prompt is ~100% identical across projects: same
intro, same checks step, same code-review checklist, same spec
warning, same verdict format. Some projects genuinely need different
emphasis:

- A static frontend: "skip the test-quality bullet, this project has
  no test suite."
- A library: "also flag breaking API changes that are not documented
  in CHANGELOG.md."
- A schema-driven codebase: "verify generated types match the schema
  files after every diff."

This is much higher leverage than a YAML key because the reviewer's
*judgment* is the lever — every PR in the project gets the
project-specific lens.

### A2.3. Project-scoped agents (Claude Code subagents)

```
<project>/.claude/agents/<name>.md
```

Already supported natively by Claude Code; garden does not need code
changes for this to work. Worth mentioning here so the wizard (Axis
3.3) knows to scaffold them when generating a project's garden
integration.

## Axis 3 — Episodic

Operations garden runs *on* a project on a cadence, rather than per
worker turn. The unifying mechanism for all three is a **Claude
session with project-tuned context**: skills bundle + rules + review
rules + per-pass extension. The difference between them is what
triggers the session and what it produces.

### A3.1. Hardening passes

Specialized polish loops on top of grow. Each pass type is a
`WorkflowDefinition`:

| Pass | Seed template | Reviewer focus | Model | Bundled skills |
|---|---|---|---|---|
| security | "Audit recent changes for…" | findings, severity | Opus | `cve-lookup`, `secret-scan` |
| test | "Strengthen test coverage on…" | coverage delta, edge cases | Sonnet | `coverage-diff` |
| stability | "Probe error paths and retries on…" | idempotency, retry safety | Opus | — |
| architecture | "Check for coupling/cycles in…" | imports graph, abstraction gaps | Opus | `cycle-detect` |
| docs | "Verify docs match code in…" | CLAUDE.md/DESIGN.md/spec drift | Haiku 4.5 | `linkcheck` |
| performance | "Inspect hot paths and allocations" | benchmarks, query plans | Opus | — |

#### Distinct vs mono — the explicit decision

The operator asked the right question. Here is the case for distinct:

- **Different model.** Security pass earns Opus; docs hygiene runs
  fine on Haiku 4.5 at a fraction of the cost. A mono pass forces one
  model across categories that have very different cost/quality
  curves.
- **Different success criterion.** Security pass `CLEAN` means "no
  unaddressed findings." Test pass `CLEAN` means "coverage delta
  non-negative and edge cases enumerated." Docs pass `CLEAN` means
  "all CLAUDE.md / DESIGN.md claims verified against code." A mono
  pass collapses these into "looks fine," which is the same problem
  grow already has when the seed is vague.
- **Different cadence.** Security might run monthly. Test pass after
  every feature. Architecture quarterly. Mono can't differentiate.
- **Composable, resumable.** "Run security and tests but not docs"
  is a one-liner with distinct passes. With mono it's a prompt
  variant.
- **Clear signal.** "3 security findings remain" beats "the harden
  loop found 5 things across categories."

The case for mono:

- **Cross-category issues exist.** A missing test that hides a
  security gap is both. A distinct pass might miss it because each
  prompt has tunnel vision.
- **One context load.** Claude already has the codebase in memory;
  running five passes loads it five times.
- **Simpler implementation.** One workflow, one config.

**Recommendation: distinct passes, but as specialized grow workflows
with shared infrastructure.** Each pass inherits grow's cold-respawn
mechanics, its iteration counter, its `.garden/grow-log.md`
discipline (or a sibling file: `.garden/security-pass-log.md`). What
differs per pass:

- Seed template (built from a category template + optional
  `<project>/.garden/hardening/<category>.md` extension)
- Reviewer prompt section (category-specific verdict vocabulary)
- Model pin
- Bundled skills

Grow stays as the unspecialized fallback for "harden whatever I just
did, I do not have a category in mind." The cross-category issue is
addressed by **running multiple passes in sequence** — `garden harden
<worker> --passes security,tests,docs` plants three passes
back-to-back. They see each other's results because they run on the
same worktree and read each other's log files.

The "one context load" argument is real but small in practice. A
single pass takes one Claude session of ~50K-100K tokens; running
five sequentially is the same cost as five separate prompts in the
same long-running session, modulo cache hits. Garden's cold-respawn
discipline already pays this cost willingly because of the iteration
hygiene it buys.

#### CLI shape

```bash
garden workers new <project> --workflow security-pass
garden workers harden <worker> --passes security,tests,docs
```

`harden` is a multiplexer that plants one pass after another, reading
each pass's verdict before deciding whether to continue. A failed
pass blocks subsequent ones (configurable).

#### Per-project tuning

```
<project>/.garden/hardening/security.md   # extends the default security seed
<project>/.garden/hardening/tests.md
<project>/.garden/hardening/archi.md
```

Each file is appended to the category's seed template. A project
without the file gets the category default.

### A3.2. Hygiene evaluator

Periodic check that a project's garden integration is still healthy.

#### What it checks

- **Garden config sanity**
  - `path` is still a git repo
  - `checks` command exits non-error on `--help` or `--dry-run`
  - `postMerge` references files that still exist
  - `trellisDir` exists or can be created
  - `claudeProfile`, if set, resolves to a valid config dir
  - `sandboxDomains` includes every host the project's tooling reaches
    (cross-checked against package manifests)
- **Auth health**
  - Claude profile credential still valid (not expired)
  - Keychain not displaced (the existing `auth status` machinery)
- **Docs vs code**
  - CLAUDE.md describes commands that exist in `package.json` / `Cargo.toml`
  - DESIGN.md (or equivalent) references files that exist
  - Architecture-overview docs name modules that still exist
  - Spec files: every "if the code disagrees, the code is wrong" file
    cross-referenced for stale claims
- **Rules freshness**
  - `<project>/.garden/rules.md` references files that still exist
  - No rules contradicting recent merged practice (heuristic, by
    sampling recent commits)
- **Skills sanity**
  - Each project skill's `SKILL.md` references files/commands that exist
  - Skill descriptions are within Claude's preferred length window
- **Trellis hygiene**
  - No vine drifting for more than `maxTrellisIterations / 2`
    iterations without an operator look
  - No retired trellis still referenced by an active worker
  - Trellis files under `trellisDir` have valid front-matter
- **Worker hygiene**
  - No worker in `failing` state for more than N hours
  - No worker with `claudeStatus` stale beyond expected event cadence

#### Output

A markdown report at `<project>/.garden/hygiene/<date>.md` with a
checklist:

```markdown
# Hygiene report — 2026-05-10

## Pass
- [x] git repo at configured path
- [x] checks command runnable
- [x] Claude profile credential valid

## Warn
- [ ] CLAUDE.md references `src/dashboard/poller.ts:120` (file moved)
- [ ] `<project>/.garden/skills/deploy/SKILL.md` references `npm run deploy:staging` (no longer in package.json)

## Fail
- [ ] sandboxDomains missing `cdn.example.com` (used by lib X)
```

#### How it runs

Three trigger points:

1. **`garden health <project>`** — manual, prints the report.
2. **`garden setup <project>` or `garden add <project>`** — runs the
   checks and offers to fix each Warn/Fail item interactively (the
   wizard, A3.3).
3. **Scheduled via `/schedule`** — weekly per project, posts to the
   alert queue on Fail.

#### Output → action

Hygiene findings can themselves seed a **docs pass** (the hardening
workflow): "fix the doc/code drift the hygiene report flagged."
This is the clean unification — hygiene reports findings, passes
fix them.

### A3.3. Setup wizard

The hygiene evaluator with interactivity, run at `garden add` time
(opt-out via `--no-wizard`).

#### Trigger

```bash
garden add ~/code/keychange/new-thing
```

After registering the project, garden asks: "Run setup wizard?" Yes
runs the full sequence. Manual rerun: `garden setup <project>`.

#### Sequence

1. **Detect stack.** Read `package.json` / `Cargo.toml` /
   `pyproject.toml` / `go.mod`. Identify language and likely test/build
   commands.
2. **Suggest `checks`.** "I see `package.json` with a `test` script
   and a `build` script. Suggest `checks: npm run build && npm test`?
   [Y/n/edit]"
3. **Suggest `postMerge`.** "I see no install step beyond `npm
   install` is needed. Skip postMerge? [Y/n/edit]"
4. **Suggest sandbox write paths.** "I see Rust — add
   `~/.cargo`? [Y/n]" / "I see node — `~/.npm` is already global, no
   action."
5. **Plot membership.** "Add to which plot? [imp / key / sha / none]"
6. **Claude profile.** Inferred from plot if A1.7 (plot inheritance)
   ships, else asked directly.
7. **Generate `<project>/.garden/rules.md`.** Launch a one-shot
   Claude session in the project root with a system prompt: "you are
   scaffolding garden integration for this project. Read the repo,
   produce a starter rules.md describing the project's language,
   tooling, code patterns, testing conventions, and git workflow.
   Match the style of the existing `<project>/.garden/rules.md`
   examples." Show diff, accept/edit.
8. **Generate `<project>/.garden/review-rules.md`.** Same pattern,
   different system prompt: "produce review-rules.md describing what
   a reviewer should additionally focus on in this codebase."
9. **Suggest project skills.** Based on detected stack, offer
   templates: a frontend project gets `screenshot-check`; a
   library project gets `api-diff`; nothing gets nothing.
10. **Run initial hygiene.** Same as A3.2 — show the report so the
    operator confirms everything resolves green.

#### Implementation note

Steps 7-9 are Claude sessions. They are *not* a normal worker — they
run in a one-shot `claude -p` headless mode in the project root, using
the `init` slash skill's pattern (`src/dashboard/skills.ts` has the
`init` skill content for CLAUDE.md generation; the wizard generalizes
that pattern to the other files).

#### Idempotency

The wizard is idempotent — running `garden setup <project>` on an
already-set-up project shows the current state, runs hygiene, and
offers to refresh stale items. Files that already exist are not
overwritten without consent.

## Unifying mechanism

All three episodic operations share infrastructure:

- **Project-tuned context.** Each invocation builds its Claude
  session's context from the project's rules + review-rules + skills
  + (for hardening passes) the category extension. The composition
  primitive (`src/dashboard/prompt-compose.ts`) already exists; it
  just needs more PromptSection consumers.
- **Cold-respawn discipline.** Hardening passes use grow's
  `LoopHooks`; hygiene and wizard are one-shot, no respawn needed.
- **Headless agent.** Hygiene and wizard run via
  `launchHeadlessAgent` (`src/dashboard/headless-agent.ts`) the same
  way reviewers and resolvers do — no tmux pane, no operator
  attention required during the run.
- **Markdown report output.** Hygiene writes
  `<project>/.garden/hygiene/<date>.md`. Hardening passes write
  `.garden/<pass>-log.md`. Wizard updates `<project>/.garden/rules.md`
  etc. directly.

This means **adding a new episodic operation is structurally similar
to adding a new workflow** — declare a `WorkflowDefinition`-shaped
thing (or a simpler "one-shot Claude session" variant), write a seed
template, register it. The wizard is the operator-facing entry; the
hygiene evaluator is the cadence-driven entry; the hardening passes
are the work-on-a-branch entry.

## Phasing (suggestion, not commitment)

Each phase leaves the codebase in a working state. Skip whole phases
if they do not earn their cost.

### Phase 1 — project skills + project review rules

The single highest-leverage change. Both are file-based, both extend
hard-coded lists with a directory or file, both unlock new categories
of customization rather than parameterizing existing knobs.

- `<project>/.garden/skills/` walked by `installClaudeSkills`.
- `<project>/.garden/review-rules.md` rendered by a new
  `reviewExtraInstructionsSection`.

### Phase 2 — declarative knobs that hurt today

The ones whose absence is felt now, not someday:

- `workerModel`, `reviewerModel`
- `sandboxAllowWrite`
- `baseBranch`
- `reviewTimeoutMinutes`

Each is a one-field addition with a fallback chain.

### Phase 3 — plot inheritance (only if the matrix demands it)

Once Phase 2 ships, the per-project YAML matrix is wider. If the
operator finds themselves setting `claudeProfile: imp` and
`workerModel: sonnet` and `defaultWorkflow: grow` on every imp-plot
project, lift those values to plot config with inheritance.

Skip this phase entirely if the matrix stays sparse.

### Phase 4 — hygiene evaluator

The standalone `garden health <project>` command + a markdown report
under `<project>/.garden/hygiene/`. No wizard yet, no scheduling yet
— just the diagnostic.

The output of this phase teaches us what the wizard should automate.

### Phase 5 — setup wizard

`garden setup <project>` (and `garden add <path>` runs it by
default with `--no-wizard` opt-out). Reuses the Phase 4 checks plus
the Claude-session generators for rules.md / review-rules.md /
project skills.

Phase 4 first, Phase 5 second, because the wizard is structurally
"hygiene with interactivity and write capability." Without the
read-only diagnostic, the wizard is harder to design and trust.

### Phase 6 — hardening passes

A new `WorkflowDefinition` per pass type, sharing grow's
`LoopHooks`. Start with **one** pass (security or docs), prove the
shape, then add the others.

The order of pass types: probably **docs first** (lowest stakes,
shortest sessions, cheap model), then **security** (highest stakes,
most distinct from default grow), then the others as they earn it.

The `harden` multiplexer command lands after at least two pass types
exist — running one pass at a time is fine until composition is the
bottleneck.

## Open questions

1. **Per-pass vs per-project hardening tuning.** Should
   `<project>/.garden/hardening/security.md` be the only tuning point,
   or should there also be a global `<garden>/hardening/security.md`
   that projects layer on top of? (Probably yes for sane defaults; the
   project file just appends.)

2. **Hygiene cadence.** Weekly? Monthly? Per-project configurable? Or
   triggered by a heuristic ("project hasn't been touched in N days,
   run hygiene before the next worker plants")? The triggered model is
   nicer ergonomically but harder to implement.

3. **Wizard's authority over existing files.** Should the wizard ever
   overwrite an existing `.garden/rules.md`, or only ever extend it?
   If extend-only, how does the operator refresh? (Probably:
   wizard always shows a diff and asks; never silent overwrite.)

4. **Plot inheritance precedence.** If a project belongs to two plots
   with conflicting `claudeProfile` values, which wins? (First-listed
   plot containing the project? Most-recently-active? Reject
   ambiguity at config-save time?)

5. **Per-pass verdict vocab.** Does each hardening pass type get its
   own verdict words (security: `FINDINGS-REMAIN`/`FINDINGS-FIXED`),
   or do they all use grow's `CLEAN`/`FIXED`/`FAILED`? Specialized
   vocab is more expressive but adds parsing surface. Probably:
   start with shared vocab, specialize only if the shared form
   loses information.

6. **Wizard interactivity in a tmux pane.** Does the wizard run in
   the operator's current pane, in a new pane, or as a series of
   prompts that the dashboard hotkey-cycles to? The new-pane path is
   the most ergonomic but interacts with the dashboard's active-pane
   discipline.

7. **Hygiene findings as a worker seed.** Should a hygiene report
   automatically plant a worker to fix the Warn/Fail items? Probably
   no by default (operator approval is the gate) but a one-line
   `garden health <project> --fix` would plant a default-workflow
   worker with the report as the seed.

8. **Does any of this belong as a separate workflow vs. as
   commands on the existing default workflow?** The hardening passes
   are clearly workflows. The hygiene evaluator is a one-shot
   command. The wizard is interactive scaffolding. Three different
   shapes, three different code locations.

9. **Backwards compatibility for project skills.** If a worker has
   project skills installed, and the project later removes one of
   them, does the worker pane's existing `.claude/skills/<name>/`
   need to be removed at next worker refresh? (Probably yes; the
   skill bundle is a deterministic write each refresh.)

10. **Scope of the wizard's Claude session.** Should the wizard's
    one-shot Claude session be given the project's whole codebase
    in context, or run iteratively with a Read-then-summarize
    pattern? Whole-codebase is simpler but expensive on large
    repos; iterative is cheaper but more complex to drive.

## Out of scope

Things deliberately not in this brainstorm:

- **Project-scoped Claude Code agents** (subagents). Already
  supported natively by Claude Code via `<project>/.claude/agents/`.
  The wizard might scaffold them but garden does not need a
  config-layer for them.
- **Per-project notification routing** (ntfy / Slack on failing).
  Nice but the dashboard alerts cover the case.
- **Per-project log retention.** Real concern, separate problem.
- **Per-project worker name themes.** Cosmetic.
- **Plot-level pause/resume / active hours.** Worth designing
  later if multi-plot quota or work-life-separation pressure
  materializes; today the global `garden auto off` is sufficient.
- **Plot-level rules.md.** Plots have no directory; the storage
  problem is real. Skip until 5+ projects share a non-trivial
  guidance body.
- **Hardening pass parallelism.** Running security + tests + docs
  in parallel on the same worktree. Tempting but introduces
  filesystem race conditions (two passes editing the same file).
  Sequential composition first; parallelism only if the sequential
  cost becomes the bottleneck.

## Folding-up path

When (any of) the work this document brainstorms ships:

- Declarative knobs land in `DESIGN.md` § Configuration plus
  `CLAUDE.md` § CLI surface.
- Project skills and review rules land in `CLAUDE.md` § Conventions
  plus a short section in `DESIGN.md`.
- Hardening passes get a `WORKFLOWS.md § "Hardening passes"`
  section (mirroring the existing trellis and grow sections),
  along with one new `WorkflowDefinition` per pass type.
- Hygiene evaluator gets a `docs/HYGIENE.md` spec.
- Setup wizard gets a `docs/SETUP-WIZARD.md` spec (or merges into
  HYGIENE.md if the evaluator's design carries the wizard cleanly).

Once each component ships, the corresponding section here can be
removed. The document itself goes away when nothing speculative
remains.
