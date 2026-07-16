# Operator UI: status-pane grammar and config menus

## Status

Proposed 2026-07-12. **Phases 1–3 (the status-pane grammar) shipped
2026-07-15**; the authoritative description now lives in DESIGN.md
("Worker row grammar", "Base-branch divergence indicator", "Time-in-state
suffix") and CLAUDE.md. **Phases 4–6 (the menu system) remain speculative
— no code yet**, deferred pending operator review of the shipped pane.
This doc proposes (1) a coherent visual grammar for the status pane to
replace the accreted one-off decorations [SHIPPED], and (2) a
keybinding-driven menu system for configuring projects and workers
[not yet built] — the everyday sibling of the setup wizard sketched in
[PROJECT-CUSTOMIZATION.md](PROJECT-CUSTOMIZATION.md).

One deviation from the design below, discovered in implementation: the
per-workflow row decoration is a pure `workflowRowDecor` leaf switch on
`entry.workflow` (`src/commands/status.ts`), NOT a
`WorkflowDefinition.renderRow` method — a method would drag the poller
graph into `status.ts`'s import closure (and the `dist/hook.js` bundle),
crossing a boundary the codebase deliberately maintains. Part 1's intent
holds; only the mechanism changed.

Cross-references, so this doc composes with its neighbors instead of
duplicating them:

- `baseBranch` as a project config key is A1.3 of
  [PROJECT-CUSTOMIZATION.md](PROJECT-CUSTOMIZATION.md). Part 2 here adopts
  it and works out the status-pane and per-worker consequences.
- Per-worker crew (`workers new --crew`) and "the ⌥⇧N picker is the
  override surface" are futures in [CREWS.md](CREWS.md) ("Selection
  surface"). Parts 3.4–3.5 here give them a concrete UI.
- The per-workflow `WorkflowDefinition.renderRow` hook is the long-term
  primitive named in `WORKFLOWS.md` § "Worker row". Part 1 adopts it.

## Motivation — the accretion problem

The status pane grew by adding one decoration per feature, each answering
a real question, each choosing its own slot, color, and visibility
condition. Inventory of the current row anatomy:

| Decoration | Slot | Visible when | Color |
|---|---|---|---|
| crew badge | project header | always (baked path only — see drift below) | grey |
| diary pencil `✎` | project header | diary non-empty | grey |
| active marker `◄` | project header | focused project | default |
| focus dot `●`/`○` | worker row, col 1 | always | default |
| state icon (13 glyphs) | worker row, col 2 | always | default |
| state word | worker row, col 4 | always | row color |
| trellis bracket | activity slot | trellis workers | mixed |
| CI bracket | before activity | ci-fixing / failing:ci | default + red |
| activity text | tail | non-trellis workers | default |
| branch hint `→ base` | after activity | any sibling diverges (project-wide toggle) | yellow or grey |
| time-in-state | end of row | 6 of 15 states, >60s | grey, yellow past soft cap |
| `gate closed` | end of row | merged + gate closed | yellow |
| whole-row bold color | entire row | asking/failing/done/paused | yellow/red/green/cyan |
| stale dim | entire row | active band, >24h untouched | faint |

Each of these was individually justified. Together they exhibit five
failure modes:

1. **No grammar.** There is no rule that predicts where a new fact will
   appear, when it shows, or what its color means. Yellow currently means
   four unrelated things (base divergence, slow pipeline state, blocked on
   operator, gate closed). The operator has to learn each decoration as a
   special case — which is exactly how it was built.

2. **Conditional columns jitter.** The branch hint is the worst offender:
   one worker diverging flips *every* sibling row to show its base (grey),
   so rows gain and lose a column as unrelated workers come and go. This
   is the "branches are shown sometimes and sometimes not" complaint — the
   behavior is deliberate (`projectHasBranchDivergence` in
   `src/commands/status.ts`) but reads as nondeterminism.

3. **Identity is invisible.** The row shows what a worker is *doing* but
   almost nothing about what it *is*. A Codex worker is indistinguishable
   from a Claude worker. A `--model sonnet` pin is invisible. A grow
   worker shows no loop counter (trellis gets a bracket; grow — the same
   loop primitive — gets nothing). The project-level crew badge shows the
   default, but a worker overriding it via `--harness` looks identical to
   its siblings.

4. **Two render paths have already drifted.** `garden status` (TTY path,
   `status.ts` ~line 196) and the baked dashboard path (`renderQuickStatus`,
   ~line 731) assemble rows separately. The crew badge shipped only into
   the baked path; the CLI header row never got it. The time-in-state
   suffix threading was duplicated into both loops. Every future
   decoration pays this tax or drifts.

5. **Configuration is invisible and CLI-only.** Reading a project's
   setup requires `garden config <p>` + `config <p> crew` + `config <p>
   role` in a shell. Worker knobs (model, harness) exist only as
   spawn-time flags. And the single most consequential setting — which
   branch workers merge into — is not a setting at all: it is silently
   pinned from whatever the project checkout happened to be on at spawn
   time (`resolveBaseBranch`). The divergence-warning machinery in the
   status pane exists to compensate for that implicitness.

## Design principles

These are the rules that make the next ten additions land tidily instead
of repeating the accretion.

1. **Identity vs. status — two info classes, two treatments.**
   - *Identity* facts are chosen (workflow, crew/harness, model, base
     branch). They render as quiet grey badges in a fixed slot, and only
     when they differ from the project default: **default is invisible,
     override is grey.** Identity never uses attention colors and never
     affects row ordering.
   - *Status* facts happen (state, elapsed, CI, gate). They own the
     color-escalation vocabulary and the ordering comparator.

2. **Color discipline.** Grey = metadata. Yellow = needs attention soon.
   Red = blocked/failed. Green = success. Cyan = operator-held. Bold
   whole-row color remains reserved for the four whole-row states. No new
   decoration may repurpose a color across classes (the branch hint's
   yellow, an identity fact wearing an attention color, is the mistake
   not to repeat — Part 2 retires it properly).

3. **One renderer.** A single declarative row assembler shared by
   `garden status` and `renderQuickStatus`, with per-segment truncation
   priorities. Workflow-specific decoration moves behind
   `WorkflowDefinition.renderRow` so status.ts stops special-casing
   trellis.

4. **Menus mirror the CLI.** Every menu row dispatches through the same
   mutator the CLI command uses — one writer per key, shared validation.
   A menu is a *view* of config, never a second config system.

5. **Explicit over implicit for anything a menu can set.** A menu that
   "sets the default branch" requires the default branch to be a config
   key, not a side effect of the checkout. Making knobs explicit is a
   prerequisite of the menu work, not an afterthought.

## Part 1 — Status pane v2: the row grammar

### Worker row

```
<focus> <icon> <name>  <state+elapsed>  <badges>  <detail>  <flags>
```

- **focus / icon / name** — unchanged.
- **state+elapsed** — one column: `reviewing 12m`, `merging 47m`. The
  elapsed value is the same `formatTimeInState` output (same state set,
  same 60s floor, same soft-cap yellow), moved from end-of-row into the
  state column because "how long it has been reviewing" is one fact, not
  two. Column width grows from 9 to 13.
- **badges** — the identity cluster, fixed order, all grey, each shown
  only when overriding the project default:
  `→<base>  <member>  <model>  <workflow>`. Examples: `→v2-api`,
  `codex`, `sonnet`. Default workflow, default crew member, default
  model, and a base matching the project's base render nothing.
- **detail** — the live activity text, or the workflow's bracket via
  `renderRow` (see below). This is the elastic segment: it absorbs all
  width pressure.
- **flags** — end-of-row status attention that isn't a state:
  `gate closed` (yellow), `CI fix 2/3`, `CI ✗ a1b2c3d` (red). These are
  status-class and keep their colors.

Truncation priority (replaces "whatever was appended last falls off"):
the core (focus through state) and flags never drop; badges drop next;
detail is truncated first and absorbs the remaining width. A narrow pane
shows *what* and *where it stands* before it shows prose.

### renderRow: workflow decoration moves into the registry

`WorkflowDefinition` gains the `renderRow` hook WORKFLOWS.md already
names as the long-term primitive:

```ts
renderRow?: (entry: WorkerEntry) => { badge?: string; detail?: string };
```

- trellis returns its existing bracket as `detail` (unchanged output).
- grow returns `grow 2/5` — parity with trellis, fixing the asymmetry
  where one loop workflow shows its budget and the other doesn't. The
  counter data already exists (`GrowData.iteration`/`maxIterations`).
- default returns nothing; the CI bracket stays generic (it is
  status-class, not workflow identity).

status.ts drops `trellisInfoFor`/`formatTrellisBracket` special-casing.

### Project header

```
<n>. <name>  <base>  <crew>  ✎  ⚠<n>  ◄
```

- **base** — shown grey when `baseBranch` is explicitly configured
  (Part 2); e.g. `⋅v2-api`. An unset key (legacy checkout-following
  behavior) shows nothing, as today.
- **crew** — the existing badge, with one change: `all-claude` (the
  global default) is hidden per "default is invisible." An all-Claude
  fleet's headers return to their pre-crew quietness; anything else
  (including `custom`) still shows. This is a deliberate behavior change
  to a just-shipped feature and is called out in Open questions.
- **⚠n** — new: unread-alert count for this project (yellow), derived
  from the same `lastSeenAt` ack the ⌥l view uses, disappearing on ack.
  Answers "did anything happen here while I was away?" — a question the
  header currently cannot answer without switching to the logs view.
- **✎ / ◄** — unchanged.

### Mockup

Before (a busy mixed project today):

```
  2. lex ✎ ◄
    ● ⠋ plush-faint-dusk  working    Evaluating hook throttle...
    ○ ◎ neat-pure-ford    reviewing  Fix meter render → main 12m
    ○ ◆ lush-bold-dew     idle       [trellis: auth | 4/30] → v2-api
    ○ ✓ drawn-east-myth   merged     Add usage pane gate closed
```

After:

```
  2. lex ⋅v2-api ✎ ⚠1 ◄
    ● ⠋ plush-faint-dusk  working        codex   Evaluating hook throttle...
    ○ ◎ neat-pure-ford    reviewing 12m  →main   Fix meter render
    ○ ◆ lush-bold-dew     idle                   [trellis: auth | 4/30]
    ○ ✓ drawn-east-myth   merged                 Add usage pane  gate closed
```

Every fact from the before-picture survives; each now has exactly one
slot, one color class, and one visibility rule. `neat-pure-ford`'s
`→main` is grey (a deliberate override of the project's `v2-api` base),
not yellow — see Part 2 for why the warning class retires.

### One renderer

Both `status()` (TTY) and `renderQuickStatus` build rows through a single
`renderWorkerRow(segments, width)` / `renderProjectHeader(...)` pair fed
by one `collectSegments(entry, projectCtx)` function. The crew-badge
drift gets fixed by construction, and the next decoration is one segment
in one function. JSON output (`output()` path) is untouched.

## Part 2 — Explicit base branch

Adopts PROJECT-CUSTOMIZATION.md A1.3 and works out the consequences.

### The key

```yaml
projects:
  lex:
    baseBranch: v2-api
```

Resolution order at spawn: `workers new --base` (new flag, below) →
`project.baseBranch` → current checkout (today's behavior, kept as the
legacy default) → `origin/HEAD` → `main`. `WorkerEntry.baseBranch`
pinning at creation is unchanged — the key changes where the pin comes
from, not how it is consumed.

### `workers new --base <branch>`

Per-worker override, validated exactly like the spawn path validates
today (`branchExistsOnOrigin`, with the existing `tryPublishBranch`
fallback). Persisted to `entry.baseBranch` as always. This is the CLI
form of the spawn-composer row in Part 3.4.

### Divergence semantics: the yellow retires

Today's yellow `→ base` warns that the checkout moved after spawn — a
symptom of the base being implicit. With an explicit `baseBranch`:

- worker base ≠ configured base is a **deliberate override** → grey
  identity badge (`→main` in the mockup). No sibling-wide toggle: each
  row's badge depends only on that row.
- yellow remains only for a genuine fault: the worker's base branch no
  longer exists on origin (merge will fail).
- projects with `baseBranch` unset keep today's checkout-comparison
  behavior verbatim, so nothing changes until the operator opts in.

`projectHasBranchDivergence`/`showMatching` (the jitter machinery)
deletes on the configured path.

## Part 3 — The menu system

### 3.1 Shared primitive: `src/dashboard/menu.ts`

crew-picker, trellis-picker, and workflow-picker each hand-roll
display-menu argv assembly, `menuRunShell` wrapping, centering flags, and
error logging. Two more menus would make five copies. Extract the
established pattern:

```ts
interface MenuRow {
  label: string;
  key?: string;          // quick-select
  run?: string;          // shell command, menuRunShell-wrapped
  tmux?: string;         // raw tmux command (command-prompt rows)
  info?: boolean;        // read-only line (display-menu disabled row)
  sep?: boolean;         // separator
}
interface MenuSpec { title: string; rows: MenuRow[]; }
function runMenu(spec: MenuSpec): void;   // drives display-menu
```

Plan builders stay pure (tests construct and assert specs without tmux —
the pattern `buildCrewPickerPlan` already set). `info` rows use
display-menu's disabled-row form (leading `-` on the name) to render
read-only lines inside a menu — verify the fleet tmux version renders
these before relying on them; the fallback is putting the facts in the
title. The three existing pickers migrate onto `runMenu` as they are
touched, not in a big-bang rewrite.

**Form feel via re-open:** display-menu cannot live-update, so every
`_config-set`-style handler ends by re-invoking the menu that launched
it. Set a value → the menu reopens showing the new value. Fire-and-forget
process chains; no state carried in memory.

### 3.2 Project config menu — `⌥,`

`⌥,` (comma — the conventional settings key) opens the focused project's
menu. Every row shows the current value inline; the menu doubles as the
inspector, replacing three CLI invocations with one keypress.

```
Project: lex                        (crew all-codex, base v2-api)
  1  base branch    v2-api          → branch submenu
  2  crew           all-codex       → the ⌥⇧C submenu, reused
  3  roles          reviewer=codex  → role → harness/model submenus
  4  checks         npm test…       → command-prompt, prefilled
  5  post-merge     (not set)       → command-prompt, prefilled
  6  CI gate        on              → toggle
  7  holistic       shadow          → off / shadow / fix submenu
  8  profile        imp             → claude-profile submenu
  9  provider       (none)          → provider submenu
  0  log color      auto            → palette submenu
  e  edit config.yml in $EDITOR     → escape hatch for everything else
```

- The branch submenu lists local+origin branches sorted by recency
  (`git for-each-ref --sort=-committerdate`, capped at 9) plus an
  "(u) unset — follow the checkout" row.
- Long values (checks commands) truncate in the label; the submenu /
  command-prompt shows the full string.
- Every row dispatches `garden dashboard _config-set <p> <key> <value>`,
  which calls the same mutator as `garden config`. That requires
  extracting `setConfigKey` (and the role/crew handlers) from
  `src/commands/config.ts` into a shared module — dashboard code must
  not import `commands/*` (the module-graph rule trellis-picker already
  documents).
- `⌥⇧C` survives as the muscle-memory shortcut straight to row 2's
  submenu. Iteration caps (`maxTrellisIterations`, `maxGrowIterations`,
  `trellisOpusFallback`) stay CLI-only + the `(e)` escape hatch — menu
  rows are for knobs an operator adjusts more than once a quarter.

### 3.3 Worker menu — `⌥i`

`⌥i` ("inspect") opens a card for the focused worker: identity and
status as info rows, then actions, then config. This is also where the
existing worker verbs become discoverable — today `hold`/`bounce`/
`kick`/`pause` live in memory or `garden keys`.

```
Worker: neat-pure-ford (lex)
  -  reviewing 12m · merges into main · model sonnet · crew all-claude
  -  task: Fix meter render on narrow panes
  ──────────────────────────────
  1  hold / resume            (⌥e)
  2  bounce                   (⌥b)
  3  kick review
  4  pause auto-continue
  5  show last review         → opens the review in the garden pane
  ──────────────────────────────
  6  base branch  main        → branch submenu (affects next review/merge)
  7  model        sonnet      → model submenu (applies on next bounce; offers set+bounce)
  8  review crew  all-claude  → reviewer-member submenu (applies to next review)
  x  kill…                    → confirm submenu
```

- Rows 6–8 write registry fields (`entry.baseBranch`, `entry.model`,
  `entry.crew` — Part 3.5), never project config: a worker menu edits
  the worker.
- Changing a live worker's base re-targets the *next* review/merge —
  legitimate (the poller already reads `entry.baseBranch` per cycle) but
  labeled, since it changes what diff the reviewer sees.
- `kill` sits last, behind a confirm submenu, per the existing
  shell-protected `⌥x` caution.

### 3.4 Spawn composer — extending `⌥⇧N`

CREWS.md already frames the ⌥⇧N picker as the override surface ("pick
workflow, then optionally pick crew, defaulting from project config").
Generalize to base + crew:

```
New worker on lex               (base v2-api · crew all-codex)
  d  default — fast worker (same as ⌥n)
  t  trellis — pick a frozen design doc
  g  grow — bounded iteration loop
  ──────────────────────────────
  b  base branch…   [v2-api]
  c  crew…          [all-codex]
```

`b`/`c` open submenus, write a draft file
(`SESSIONS_DIR/spawn-draft-<project>.json`), and re-open the composer
with the override reflected in the bracket. Choosing a workflow consumes
and deletes the draft; drafts older than 5 minutes are ignored (a stale
draft must never silently apply to next week's spawn). `⌥n` stays the
zero-question fast path and never reads drafts.

CLI parity: `workers new --base <branch> --crew <name>`.

### 3.5 Per-worker crew

The "different crew for one worker" ask decomposes along the existing
build/review split, and the two halves have different mutability:

- **Worker member** (which harness/provider builds): already per-worker
  at spawn (`--harness`, `entry.harness`). Changing it on a live worker
  means respawning the agent process — out of scope for v1; the spawn
  composer is the surface.
- **Review member** (which harness reviews/resolves/ci-fixes): safe to
  change any time, since it applies at next review launch. Store
  `entry.crew`; `resolveReviewRole` gains an entry-override layer ahead
  of `project.roles` — the `resolveRole(project, workflow, role)`
  generalization CREWS.md sketches, plus an entry parameter.

`workers new --crew <name>` sets both halves at spawn (worker member via
the existing harness/provider paths, review member via `entry.crew`).
The worker menu's row 8 edits the review half live. The status pane
shows the member badge per Part 1 whenever it differs from the project's.

## Keybinding additions

One row each in `DASHBOARD_HOTKEYS` (single source keeps `garden keys`
honest automatically):

| Key | Action | Category |
|---|---|---|
| `⌥,` | Project config menu (focused project) | Projects |
| `⌥i` | Worker menu (inspect + act on focused worker) | Workers |

Free-key inventory says `,` and `i` are both unbound (`c` was retired
back to the operator and stays retired). If a terminal proves unable to
deliver `M-,`, the fallback is `⌥m`. `⌥⇧C` and `⌥⇧N` keep their bindings
and become entry points into the same submenus.

## Phasing

Each phase is independently mergeable and leaves the pane fully working.
Phases 1–3 shipped 2026-07-15; 4–6 deferred pending operator review.

1. **One renderer.** [SHIPPED] Extract the shared segment assembler; both
   paths render through it. Behavior change limited to fixing the
   crew-badge drift on the CLI path. Mostly a refactor with a parity test —
   this is what makes phases 2–3 cheap and safe.
2. **Explicit base.** [SHIPPED] `baseBranch` config key, `workers new
   --base`, spawn resolution order (`resolveSpawnBase`), new divergence
   semantics (grey badge / fault-only yellow) on configured projects,
   `⋅base` header token. Unset projects byte-identical.
3. **The re-skin.** [SHIPPED] Identity badges (member/model), the
   `workflowRowDecor` leaf switch (NOT a `renderRow` method — see Status)
   with grow-bracket parity, state+elapsed column merge, truncation
   priorities, `⚠n` alert token, `all-claude` badge hiding.
4. **Menu primitive + project menu.** [not yet built] `menu.ts`, mutator extraction out
   of `commands/config.ts`, `⌥,`, `_config-set` dispatch, re-open
   chaining. Existing pickers migrate opportunistically.
5. **Worker menu.** [not yet built] `⌥i`, info rows, action rows,
   registry-field config rows (base/model), `show last review` view
   plumbing.
6. **Spawn composer + per-worker crew.** [not yet built] Draft files,
   `--base`/`--crew` CLI parity, `entry.crew` + `resolveReviewRole` entry
   layer.

## Rejected and deferred

- **Full-screen TUI config form** (display-popup + an interactive
  process): strictly more capable, but display-menu already ships in
  three pickers, needs no new interaction model, and covers every knob
  garden has. Revisit only if the menus demonstrably cramp (e.g. a
  future knob needs multi-field editing in one screen).
- **Per-worker provider.** Provider env is baked into the spawn command;
  a per-worker override is feasible but adds spawn-time env plumbing for
  a need nobody has hit. The project key + per-worker harness covers the
  current matrix.
- **Changing a live worker's harness/model without bounce.** The agent
  process pins these at launch; "set + bounce now" in the worker menu is
  the honest version.
- **Plot-level config inheritance.** Sequencing per
  PROJECT-CUSTOMIZATION.md A1.7: ship project-level values first.
- **A `garden legend` glyph reference.** Thirteen state icons is a lot of
  vocabulary, but the state *word* sits right next to the icon on every
  row; a legend documents a problem better solved by the grammar.

## Open questions

1. **Hide the `all-claude` crew badge?** "Default is invisible" says yes;
   it is also a visible change to a badge that shipped two days ago. The
   alternative — keep it always-on — costs one grey word per header and
   one asterisk on the grammar rule.
2. **`⌥,` vs `⌥m`.** Comma is the convention; `m` is the mnemonic. Needs
   a one-minute test that the operator's terminal delivers `M-,` as
   Meta+comma.
3. **Elapsed placement.** Merging elapsed into the state column widens
   every row by 4 columns even when no elapsed is showing. If narrow
   panes bite, the fallback is keeping elapsed end-of-row but adopting
   the rest of the grammar unchanged.
