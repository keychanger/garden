# Desktop notifications: native macOS alerts when a worker needs you

> This document lives under `docs/future/` — it describes an unshipped
> design. Workers must not act on it (no `garden notify` command exists,
> no `notify` config key is live, no `src/dashboard/notify.ts` module
> exists). See `rules.md` § Specifications and documentation.

Design for **desktop notifications**: garden raising native macOS banners
(and optionally a sound) when a worker reaches a state the operator cares
about — primarily "a worker finished" and "a worker is stuck and needs
help" — so the operator can step away from the dashboard and still be
pulled back at the right moment.

A secondary, larger want is a **menu-bar status app** the operator can
click to see worker status at a glance. This doc treats the banner path as
the primary, near-term design and the menu-bar app as a separate, heavier
track sketched at the end.

## Status

Not started. No code, no CLI surface, no config keys. The two integration
chokepoints this design hangs off of already exist and are stable
(`transitionState`, `addAlert`), so the banner path is small — roughly an
hour of work for the zero-dependency variant.

## Intent

The dashboard already surfaces every operator-visible event two ways: a
red unread-count badge in the tmux status bar (`refreshAlertBadge`,
`alerts.ts:212`) and the per-project status pane. Both require the
operator to be *looking at the dashboard*. The gap this design closes:
when the operator has tabbed away — different desktop, laptop lid-adjacent,
making coffee — there is no out-of-band signal that a worker merged, went
`done`, or got stuck. They come back minutes or hours later and discover a
fleet that finished long ago, or a worker that has been parked in
`failing` waiting for them.

The originating ask was framed as two ideas: (1) "a sound and banner so I
get alerted when a worker is done," and (2) "an app in the top bar I can
click to see worker status." These are different mechanisms answering
overlapping needs, and they decompose cleanly onto garden's existing
event model.

## The reframe: two event sources, not one

"Worker is done" and "worker needs help" are **different events from
different chokepoints**, and conflating them produces a worse design.

- **Success / completion** is a *state transition*. A worker becomes
  `merged` or `done` exactly once, at a single gate:
  `transitionState(project, worker, toState, …)` in
  `src/dashboard/poller-state.ts:25`. Every workflow's terminal-state
  path flows through it (`poller-merge.ts:487-488` for default
  `done`/`merged`, `:603` for grow budget-exhausted `done`). This is the
  precise, deduplicated "a worker just finished" signal — it fires once
  per worker per completion, not once per poll.

- **Failure / needs-help** is already modeled as an *alert*. Every stuck
  state raises `addAlert(...)` (`alerts.ts:132`) — rebase conflict
  (`poller-merge.ts:133`), CI budget exhausted (`poller-ci-fix.ts:186`),
  review timeout (`poller-review.ts:645`), resolver give-up
  (`poller-resolve.ts:121`), and ~25 other sites. These are already
  level-tagged (`warn` | `error`) and already deduplicated within a
  one-hour window.

So the design is **not** "add notifications to one place." It is: tap the
two existing chokepoints, each of which already has exactly the right
firing semantics. The completion signal rides `transitionState`; the
needs-help signal rides `addAlert`. A single shared `notify.ts` renders
both.

## Verified constraints

These were checked against the code and are load-bearing.

1. **No native-notification mechanism exists today.** No `osascript`
   `display notification`, no `terminal-notifier`, no `afplay`, no
   `node-notifier`, anywhere in `src/`. The only `osascript` use is
   iTerm window control in `rebuild.ts`, unrelated. This is greenfield.

2. **The poller is a normal GUI-session process.** `transitionState` and
   `addAlert` execute inside the per-project poller, which runs in a
   hidden tmux window — but that is still a process in the operator's
   logged-in macOS GUI session. `osascript -e 'display notification …'`
   and `afplay` reach Notification Center and the audio device with no
   special entitlement. (A LaunchDaemon or ssh-only session would *not*
   — but garden's poller is launched from the operator's interactive
   shell, so this holds.)

3. **`osascript` banners cannot deep-link.** `display notification` shows
   a banner and plays a sound but has no click action — clicking it does
   nothing useful. Only `terminal-notifier -execute '…'` (or a real app)
   can make the banner *focus the relevant worker* on click. This is the
   single reason to prefer the dependency variant.

4. **Dedup is already solved for the alert path, not the transition
   path.** `addAlert` suppresses identical-key alerts for one hour
   (`alerts.ts:41,114`). `transitionState` has no such guard — but it
   doesn't need one for completion, because a worker transitions to
   `merged`/`done` exactly once. The risk is *flapping* states
   (`working → reviewing → working` on a mid-review push,
   `poller-review.ts:792`), which the design must not notify on. Only
   **terminal** states notify (see "Which events").

5. **There is already a global-gate config pattern to mirror.**
   `autoContinue` (`config.ts:180-200`) is a `Partial<…>` sub-object on
   `GardenConfig` with an `enabled` flag and a typed defaults object,
   toggled by a `garden auto …` command. Desktop notifications should
   follow the identical shape (`notify?: Partial<NotifyConfig>`,
   `garden notify on|off|…`) rather than inventing a new config idiom.

## Design: the banner path

### Module

A new `src/dashboard/notify.ts` exporting one function:

```ts
export function notifyDesktop(opts: {
  title: string;        // e.g. "garden · acme"
  message: string;      // e.g. "worker bright-fox merged"
  level: "info" | "warn" | "error";
  sound?: boolean;      // defaults from config
  focusTarget?: { project: string; worker: string }; // for -execute
}): void
```

It is **fire-and-forget and never throws** — a notification failure must
never break a state transition or an alert write. Wrap the child-process
spawn in try/catch, swallow errors to a debug log. It is also **macOS-only
by guard**: `if (process.platform !== "darwin") return;` at the top, so
the call sites stay unconditional and Linux/CI is a silent no-op.

All interpolated strings (worker names, messages) go through the existing
`shellEscape` from `tmux.ts` per the repo convention — worker/branch names
are operator-controlled but messages can embed git error text.

### Backend selection

Three variants, in increasing capability:

| Variant | Banner | Sound | Clickable | Setup |
|---|---|---|---|---|
| **A1** built-in | `osascript -e 'display notification …'` | `afplay /System/Library/Sounds/<name>.aiff` | no | zero deps |
| **A2** terminal-notifier | `terminal-notifier -message … -title …` | `-sound <name>` | **yes** — `-execute 'garden …'` | `brew install terminal-notifier` |
| **A3** auto-detect | A2 if `terminal-notifier` on `PATH`, else A1 | both | when A2 available | zero required deps, best-effort upgrade |

**Recommendation: A3.** Detect `terminal-notifier` once (cache the
lookup), use it when present for clickable banners, fall back to the
zero-dependency `osascript`+`afplay` path otherwise. The operator gets a
working notification with no install, and a *better* one if they opt into
the brew package. A1 alone is the acceptable MVP if A3's detection branch
is deemed not worth it on day one.

For A2/A3, `-execute` runs a shell command on click. The natural target is
a `garden focus <project> <worker>`-style command that attaches the
dashboard and swaps the worker into the right pane. If no such single
command exists yet, the click action can fall back to
`tmux switch-client` / `select-window` against the worker's window — or
this can ship banner-only first and add the click action in a follow-up.

### Config surface

Mirror `autoContinue` exactly:

```ts
export interface NotifyConfig {
  enabled: boolean;        // master switch
  sound: boolean;          // play a sound with the banner
  soundName: string;       // e.g. "Glass" (a /System/Library/Sounds name)
  onDone: boolean;         // notify on merged/done
  onFailing: boolean;      // notify on failing / needs-help
  onAllAlerts: boolean;    // also notify on every warn/error addAlert
}

export const NOTIFY_DEFAULTS: NotifyConfig = {
  enabled: false,          // opt-in; off until the operator turns it on
  sound: true,
  soundName: "Glass",
  onDone: true,
  onFailing: true,
  onAllAlerts: false,      // off by default — ~25 alert sites would be noisy
};
```

Hung on `GardenConfig` as `notify?: Partial<NotifyConfig>` with a
`getNotifyConfig()` accessor, exactly like `getAutoContinueConfig`.

Default **off**. Native banners are intrusive; the operator opts in. (An
alternative is default-on with `onAllAlerts` off — defensible, but
opt-in is the safer first ship for a daily-driver tool.)

### CLI surface

A `garden notify` command following the `garden auto` shape
(`commands/index.ts` registration, help text in `cli.ts`):

```
garden notify on|off|status
garden notify sound on|off
garden notify done on|off
garden notify failing on|off
garden notify test            # fire a sample banner to verify wiring
```

`garden notify test` is worth having — it sidesteps "did the brew
install work / does my Notification Center allow Terminal" debugging by
firing one banner on demand.

### Integration points

Two call sites, both guarded by config:

1. **Completion** — in `transitionState` (`poller-state.ts:25`), after the
   field write, branch on terminal `toState`:

   ```ts
   if (toState === "merged" || toState === "done") {
     const cfg = getNotifyConfig();
     if (cfg.enabled && cfg.onDone) {
       notifyDesktop({
         title: `garden · ${projectName}`,
         message: `worker ${workerName} ${toState}`,
         level: "info",
         focusTarget: { project: projectName, worker: workerName },
       });
     }
   }
   ```

   `transitionState` is already the place a one-shot handoff callback
   fires on terminal states (`poller-state.ts:58-97`), so adding a second
   terminal-state side-effect here is consistent with how the gate is
   already used. **Only** `merged`/`done` (and `failing`, below) notify —
   never the intermediate states, so flapping `working ↔ reviewing` is
   silent.

2. **Needs-help** — two options, pick one:
   - **Narrow (recommended):** also branch on `toState === "failing"` in
     `transitionState`, gated by `cfg.onFailing`. One code path, fires
     exactly when a worker parks needing the operator.
   - **Broad:** call `notifyDesktop` from inside `addAlert`
     (`alerts.ts:132`) for every `error`-level alert, gated by
     `cfg.onAllAlerts`. More coverage (catches alerts that don't change
     worker state, like post-merge command failures) but noisier, and it
     fires from ~25 sites. Reuses `addAlert`'s existing one-hour dedup for
     free, which is the one advantage.

   Ship the narrow path first. The broad path is a config flag
   (`onAllAlerts`) the operator can opt into later if the `failing`-only
   signal proves too narrow.

### Edge cases and non-goals

- **Multi-merge bursts.** A fleet finishing together fires N banners in
  quick succession. macOS Notification Center coalesces same-title
  banners reasonably; if it proves spammy, a debounce in `notify.ts`
  (collapse "3 workers merged in acme" within a 10s window) is a clean
  follow-up. Not in the MVP.
- **Provider/headless runs.** The `platform !== "darwin"` guard and the
  GUI-session constraint (constraint 2) mean a garden running over pure
  ssh or in CI simply no-ops. Correct behavior, no special-casing needed.
- **Notification Center permissions.** The first `osascript`/
  `terminal-notifier` banner may require the operator to allow
  notifications for Terminal/iTerm/`terminal-notifier` in System
  Settings. `garden notify test` plus a one-line note in the command's
  output covers this; garden can't grant the permission itself.
- **Not** a replacement for the tmux badge or status pane — additive. The
  in-dashboard signals stay; banners are the out-of-band layer.

## Design: the menu-bar app (separate, heavier track)

The "app in the top bar I can click" want is real but is a different
artifact with a different cost. Three rungs:

- **B1 — SwiftBar / xbar plugin (light).** A script garden ships
  (`garden menubar` emitting xbar-format stdout, or a standalone plugin
  file) that reads `dashboard.registry.json` + `dashboard.state.json` and
  prints a menu-bar line plus a clickable dropdown of per-worker status.
  Roughly half a day. Cost: it **polls** the state files on SwiftBar's
  refresh interval, which is mild friction against garden's event-driven
  ethos (`feedback_snappiness`), and it requires the operator to install
  SwiftBar. The state files are already atomic and type-guarded
  (`readRegistry`/`readDashState`), so the read side is safe and trivial.

- **B2 — native `NSStatusItem` app (heavy).** A real Swift menu-bar app
  with proper Notification Center integration, click-to-focus, and live
  status. Days of work, a separate repo and build, and code-signing if it
  is ever distributed beyond the operator's machine. This is the "real
  app" version and is a genuine side project, not a garden feature.

- **B3 — push/remote.** Out of scope for mac-local, but worth noting the
  banner path generalizes: the same two chokepoints could drive a push
  notification to a phone (e.g. via an external service) for an operator
  who is away from the machine entirely. Not designed here.

**Relationship to the banner path:** A2's clickable banner
(`-execute 'garden focus …'`) delivers ~80% of the "click to see status"
desire — a banner *is* a click target that takes you to the worker —
without any standalone app. The recommendation is to ship the banner path
first and treat the menu-bar app as an independent, later decision rather
than a dependency.

## What this is not

- Not a polling loop. The banner path adds **zero** new timers — it rides
  events that already fire (`transitionState`, `addAlert`). This preserves
  STATUS.md's no-fallback-poll invariant. (The menu-bar B1 variant *does*
  poll, which is one more reason it is a separate track.)
- Not cross-platform notification infrastructure. macOS-only by guard;
  Linux is a silent no-op. A `notify-send` branch for Linux is a trivial
  future addition inside `notify.ts` but is not designed here.
- Not a new event taxonomy. It reuses the existing `merged`/`done`/
  `failing` states and the existing `warn`/`error` alert levels verbatim.

## Recommended first slice

If/when this graduates out of `docs/future/`:

1. `src/dashboard/notify.ts` — A3 backend (auto-detect terminal-notifier,
   fall back to osascript+afplay), `platform` guard, try/catch swallow.
2. `NotifyConfig` + `getNotifyConfig()` in `config.ts`, mirroring
   `autoContinue`. Default off.
3. Two guarded call sites in `transitionState` — `merged`/`done`/
   `failing`.
4. `garden notify on|off|status|test` command + help text + a unit test
   that asserts `notifyDesktop` no-ops off-platform and when disabled.

The `onAllAlerts` broad path and the menu-bar app are deliberately *not*
in the first slice — each is a clean, severable follow-up.
