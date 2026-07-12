# Multi-Model and Multi-Harness Architecture

Design target for extending garden beyond Claude Code + Anthropic:
workers that run on arbitrary model providers (DeepSeek, Ollama-hosted
open-source models, OpenAI) and, where justified, arbitrary agent
harnesses (Codex CLI, opencode). The architecture makes adding a new
*provider* a registration — config, not code. Adding a new *harness* is
writing an adapter (code), but against a fixed interface that no longer
requires touching the dispatcher, pollers, or state machine.

## Status

**Phases 1-3 are implemented; Phase 4 is in progress** — reframed
2026-07 around a per-role resolution matrix (arbitrary `(harness,
provider, model)` per role, opinionated-by-default) with **Codex-as-
reviewer** as the operator's primary use case; see the reviewer-first
Phase 4 slices in the phased plan below (the Codex facts there are
live-verified against codex 0.142.5, not the June snapshot). Phase 1 (the provider layer): `garden provider`, the
`provider` project-config key, worker env injection, sandbox egress
union, reviewer Opus pinning, and usage-meter gating. Phase 2 (the
neutral core): the `agentStatus`/`lastEventAt` rename with registry
migration, the normalized lifecycle event vocabulary on
`WorkflowHookHandlers`, opaque model strings end to end with `--model`
accepted on every workflow, and meter-neutral gate/fallback readers. Phase 3 (the
harness adapter registry): `HarnessAdapter` + the `claude-code`
reference adapter in `src/dashboard/harness/`, the five launch builders
collapsed onto `buildAgentCommand`, headless/transcript/prompt-delivery/
transient-error/session-identity routed through the registry, and
`WorkerEntry.harness`. Commissioned 2026-06-03 from a full coupling
audit of the codebase (~150 coupling points across 8 subsystems) plus a
landscape survey of harnesses, providers, and agent protocols, with
load-bearing external claims independently re-verified against primary
sources. External-landscape facts are a snapshot **as of June 2026** and
will go stale; re-verify before implementing a phase that depends on
them. Each remaining phase is independently mergeable and leaves garden
fully working for the existing Claude-only fleet.

Where Phase 1's implementation deliberately settled or trimmed the
original sketch:

- `ProviderProfile` carries no `kind` enum — providers are
  API-key-backed by construction, which *is* the structural
  subscription-OAuth exclusion (the type has no field that could
  reference an OAuth credential). A Bedrock/Vertex `cloud-iam` kind
  remains future work.
- The `meter` field is omitted until a second meter source exists; with
  it, the neutral `Meter[]` render seam moved from Phase 1 to Phase 2
  (a render abstraction with one producer is premature). Phase 1 ships
  the gating only: the usage poller and hook-path refresh skip, and the
  pane says why, when every project runs on a provider.
- Reviewer pinning is unconditional, not opt-out: provider-backed
  projects always get an Anthropic reviewer pinned to Opus. The
  per-project relax knob waits for a concrete need.

Where Phase 3's implementation deliberately settled or trimmed the
original sketch:

- The adapter splits into a light `HarnessCore` (command dialects, prompt
  delivery, transcript reading, transient-error shapes — resolved via
  `harness/core.ts`) and the full `HarnessAdapter` (adds
  `installRuntimeConfig`, resolved via `harness/index.ts`). The split is
  load-bearing for `dist/hook.js` size: the adapter object retains every
  method it references, and the config installer's closure carries the
  skills/sandbox content — bundling them into one object grew the hook
  bundle ~19% mid-implementation. The split plus `package.json`'s new
  `"sideEffects": false` (import-time side effects are now forbidden
  outside entry points) keeps the shipped bundle neutral relative to the
  pre-adapter baseline (~166kb with production flags); a guard test pins
  the shaking so it cannot silently regress.
- `deliverPrompt`/`readTurns` call sites inside the hook-bundle closure
  (`continue.ts` prompt injection, `header.ts` history view) still call
  `pasteAndSubmit`/`conversation.ts` directly — routing them lands with
  the second adapter, which is what makes the indirection real.
- The per-worker `--provider` flag and model intent tiers defer again,
  to Phase 4 — same reasoning as before; the adapter seams they thread
  through now exist.

Where Phase 2's implementation deliberately settled or trimmed the
original sketch:

- The per-worker `--provider` flag on `workers new` moved to Phase 3: a
  per-worker provider must thread through sandbox generation, resume,
  bounce, loop respawn, and the reviewer pin together with
  `WorkerEntry.harness`, and a half-threaded override that silently
  reverts to the project provider on respawn would be worse than
  project-level-only. Model intent tiers (workhorse/quality) likewise
  wait for the adapter interface they parameterize.
- The `Turn[]` transcript seam needed no new code: `resolveTranscriptPath`
  + `readConversation → Turn[]` in `conversation.ts` are already the
  typed, exported contract; Phase 3 makes them adapter-supplied.
- The usage pane renders the 5h and weekly rows plus one row per
  model-scoped weekly meter (the `weekly_scoped` entries in the response's
  `limits[]` array, `fable` on current plans); the neutral `Meter[]`
  accessor (`snapshotMeters`) feeds the auto-continue gate. The row count
  is dynamic — the pane auto-resizes to the meter set (zero model-scoped
  meters → two rows).

## The two axes

"Support other models" decomposes into two independent axes that the
current codebase fuses into one:

- **Axis 1 — provider**: who serves the tokens. The agent CLI in the pane
  stays Claude Code; requests route to a different backend speaking the
  Anthropic Messages API.
- **Axis 2 — harness**: which agent CLI runs in the pane. A different
  binary with different flags, config files, lifecycle events, and
  transcript format.

The single most consequential finding of the audit: **almost everything
garden depends on is a feature of the harness, not of the model.** Hooks,
the sandbox, permission auto-approval, the transcript JSONL, session
resume, system-prompt injection — all client-side Claude Code behavior
that works identically no matter which backend serves the response. The
corollary: most of the operator's immediate goals (DeepSeek, Ollama-hosted
open-source models) are served entirely by Axis 1, which is a small,
low-risk change. Axis 2 is the deep refactor, and it is only needed for
models reachable solely through a foreign harness (OpenAI models via
Codex CLI) or when a foreign harness is desirable in its own right.

Axis 1 is real and officially supported on all three sides as of mid-2026:

- Claude Code documents `ANTHROPIC_BASE_URL` (route to any gateway
  speaking Anthropic Messages), `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`
  (credential), `ANTHROPIC_MODEL` plus `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`
  (what the model aliases resolve to), and `CLAUDE_CODE_SUBAGENT_MODEL`.
- DeepSeek ships a first-party Anthropic-compatible endpoint
  (`https://api.deepseek.com/anthropic`) with an official Claude Code
  setup guide. Note its two mappings disagree: the endpoint's default
  name-prefix mapping sends `opus` to `deepseek-v4-pro` and
  `sonnet`/`haiku` to `deepseek-v4-flash`, but DeepSeek's *recommended*
  Claude Code env config deliberately pins sonnet to `deepseek-v4-pro`
  too. Garden's `modelMap` must choose deliberately per profile rather
  than inherit either default. (Model names as documented June 2026 —
  illustrative, not defaults to hardcode.)
- Ollama ships a native Anthropic-compatible `/v1/messages` endpoint and
  an `ollama launch claude` helper (`ANTHROPIC_BASE_URL=http://localhost:11434`,
  `ANTHROPIC_AUTH_TOKEN=ollama`), covering both local models and Ollama
  Cloud (`qwen3-coder:480b-cloud`, `glm-5:cloud`, etc.). The base URL
  must be the bare host — a `/v1`-suffixed URL silently drops streaming
  tool-call chunks.

One hard legal constraint shapes Axis 1. Anthropic restricts
**subscription OAuth credentials** to native Anthropic apps (technical
server-side enforcement live since 2026-01; terms formalized 2026-02-19;
third-party subscription coverage formally cut off 2026-04-04). Pointing
Claude Code at a non-Anthropic backend is itself fine — but the
credential for that backend is the provider's own API key. The invariant,
stated precisely: *a profile whose credential is a Claude subscription
OAuth blob may only target the default Anthropic endpoint.* Garden
enforces this structurally in profile validation.

## What garden requires from a harness

Distilled from the audit, in descending order of how load-bearing they are:

1. **A turn-end signal.** The Stop hook is the *autonomous* entry point
   to the review/merge pipeline (`hooks/default.ts` `onTurnEnded` →
   commits-ahead check → `pendingReviewAt` → FIFO poke). Operator
   overrides exist (`garden kick`, trellis plant, internal re-review
   re-entries also set `pendingReviewAt`), but a worker that never
   signals turn-end can never advance itself, and STATUS.md forbids
   fallback polling. This requirement is non-negotiable.
2. **A long-lived interactive TUI in a tmux pane** that accepts
   `send-keys`-injected prompts. The pane *is* the product; garden's
   prompt injection (`continue.ts` → `pasteAndSubmit`) and the operator's
   direct typing both assume it.
3. **A headless one-shot mode**: run a prompt in a cwd, write the final
   answer to stdout, select a model per invocation
   (`headless-agent.ts:75` — `claude -p [--model m] < prompt > result`).
   Reviewer, resolver, and ci-fix all ride this.
4. **Permission auto-approval + sandbox.** Garden does not implement its
   own sandbox: `sandbox.ts` builds a config object that is serialized
   into `.claude/settings.json` and *Claude Code* enforces it
   (Seatbelt/bubblewrap). A foreign harness must bring its own equivalent
   (or run unsandboxed, which is unacceptable for autonomous workers).
5. **System-prompt/rules injection** at session start
   (`--append-system-prompt-file` today).
6. **An on-disk transcript** parseable into the history view's `Turn[]`
   model (`conversation.ts`).
7. **Working/asking status signals** (PostToolUse heartbeat,
   PermissionRequest → `asking`). These degrade gracefully — losing them
   costs status fidelity, not correctness.
8. **Session resume** (`--resume <uuid>`) — powers `bounce` and
   interrupt-recovery. Degradable to cold-restart.
9. **Credential/profile isolation + usage metering.** Per-provider
   concerns; metering is already optional in spirit (it gates
   auto-continue, it does not gate correctness).

## Current coupling map

Where the Claude-specific assumptions live, by subsystem, with the
severity classification used throughout the audit (*env-swap*: fixed by
changing env/config; *adapter-method*: needs a method on a harness
adapter; *architectural*: the surrounding design assumes Claude Code
semantics):

| Subsystem | Chokepoints | Dominant severity |
|---|---|---|
| Session launch | Five sibling builders in `create.ts` (`buildWorkerCommand`, `buildResumeCommand`, `buildWorktreeWorkerCommand`, `buildWorktreeBootstrapScript`, `buildWorktreeResumeCommand`) all string-concatenate the same `claude --rc [--session-id\|--resume] ... --append-system-prompt-file ...` shape | adapter-method |
| Hook/status engine | `buildSettingsJson` (`create.ts:48-104`) binds six Claude hook events; `hook-dispatcher.ts` routes garden's already-shortened event names (`stop`, `prompt`, `posttooluse`, ..., plus a seventh, `notification`); `agentStatus` written by the hook handlers for in-session transitions, by the tmux pane-died handler and `validate.ts` reconciliation for `exited`, and by the bounce/attach resume paths for `idle` (because `--resume` does not fire SessionStart) | **architectural** |
| Headless agents | `launchHeadlessAgent` (`headless-agent.ts`) — already a single clean primitive, but hardcodes the `claude -p` contract and `"opus" \| "sonnet"` | adapter-method |
| Transcript/history | `conversation.ts` parses Claude's JSONL envelope, content blocks, and tool-name vocabulary; the seam is two-part: `resolveTranscriptPath(entry)` (derives `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) + `readConversation(path) → Turn[]` | adapter-method |
| Credentials/usage | `credentials.ts` models every credential as a Claude OAuth blob (Keychain entry, refresh endpoint); `usage.ts` parses Anthropic's flat `five_hour`/`seven_day` buckets plus the model-scoped `weekly_scoped` entries in the `limits[]` array; consumed by the auto-continue gate (`poller-merge.ts checkUsageThreshold`) and trellis model fallback (`trellis-model.ts` via `findScopedMeter`); `usage-poller.ts` runs a dedicated hidden window polling Anthropic's usage endpoint | **architectural** |
| Sandbox/skills/rules | Sandbox config and `.claude/skills/` bundling are delivered through Claude's settings file; `*.anthropic.com` domains hardcoded in `sandbox.ts` `DEFAULT_DOMAINS` | adapter-method |
| Config/registry | `claudeProfile` is the only provider knob; `"opus" \| "sonnet"` union leaks through `WorkflowDefinition`, `WorkerEntry`, `trellis-model.ts`, CLI flag parsing; `commands/workers.ts` rejects `--model` outside trellis | adapter-method |
| Model policy | `trellis-model.ts` encodes Anthropic's plan economy end to end: Sonnet workhorse, Opus fallback, 7-day Sonnet meter | **architectural** |

Residual, out of scope: the `_dashboard-claude` interactive launcher
(`src/dashboard-claude.ts`) spawns a bare `claude` for the operator; its
hotkey was retired and it is not part of the worker lifecycle — fold into
the Phase 3 adapter or delete, either is fine.

What is already harness-neutral and stays untouched below the adapter
line: the tmux layout and swap-pane machinery, the pollers and FIFO, the
state machine (`prState`, `transitionState`), all git/worktree mechanics,
atomic state writes, the verdict-on-last-line contract (`verdict.ts` is
pure text scanning), prompt prose in `prompts.ts`/`prompt-compose.ts`,
plots, alerts, logs. That is most of garden.

## Landscape (snapshot, June 2026)

Capability profiles of the named targets against the requirements above:

**Claude Code + provider routing (Axis 1).** Requirements 1-8 unchanged —
hooks fire client-side regardless of backend, transcripts still written,
sandbox still enforced. Only metering (req 9) genuinely breaks:
subscription quota bars are meaningless against third-party backends.
Costs to know about: DeepSeek's Anthropic endpoint ignores `cache_control`
(and Claude Code emits prompt-caching markers by default — see
`DISABLE_PROMPT_CACHING` — so every request pays full-prefix cost unless
DeepSeek's automatic server-side prefix cache happens to hit), and drops
images and MCP content types. Ollama needs `num_ctx >= 64k` (its
4096-token default silently truncates mid-loop) and its compat endpoint
lacks `tool_choice` and prompt caching. Small local models (<14B) are
unreliable at tool calling — the community floor for agentic work is
24-32B, and Ollama Cloud models avoid the local tool-call translation
bug class entirely.

**Codex CLI (Axis 2, OpenAI models).** A strong target across the board.
Events: in addition to the older single-event `notify` config
(agent-turn-complete only), Codex ships a first-class hooks system
(`~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or `[hooks]` tables
in `config.toml`) covering SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, PermissionRequest, Stop, SubagentStart/Stop, and
Pre/PostCompact, delivering one JSON object on stdin with `session_id`,
`cwd`, and `hook_event_name` — a near-1:1 match for the event surface
garden already consumes. Documented caveat: PreToolUse/PostToolUse do
not yet intercept all shell calls ("only the simple ones") nor
WebSearch-style non-shell tools, so the working heartbeat is partial.
Headless: `codex exec` with `--json` NDJSON events, `--output-schema`,
`--cd`, per-call `--model`, and `codex exec resume <id>`. Transcripts:
rollout JSONL at `~/.codex/sessions/.../rollout-*.jsonl`
(reverse-engineered schema, not contractual). `CODEX_HOME` is the exact
`CLAUDE_CONFIG_DIR` analog. Own sandbox (`sandbox_mode`) and approval
bypass (`--ask-for-approval never`). Rules injection via `AGENTS.md`,
not a system-prompt flag. Session identity is Codex-assigned, not
caller-supplied. No machine-readable quota endpoint yet. Codex is itself
multi-provider (`[model_providers]`, first-class Ollama via `--oss`).

**opencode (Axis 2, 75+ providers).** Strong event model: `opencode
serve` exposes an SSE event bus (`session.idle` = turn-end,
`tool.execute.before/after` = tool heartbeat, `permission.asked` =
asking) and a plugin system that can fire external programs on any event.
Headless `opencode run --model provider/model --format json`. JSON
session storage on disk. Caveat: Anthropic models only via paid API key
(Claude subscription OAuth was removed after an Anthropic legal request,
2026-03/04), so an opencode worker buys non-Anthropic providers in
practice — much of which Ollama-behind-Claude already covers.

**Not early targets.** goose (no lifecycle hooks — would force polling),
aider (no events, lossy markdown transcript), crush (hooks "preliminary",
headless not first-class), gemini-cli (single-provider and sunsetting
2026-06-18 in favor of the closed-source Antigravity CLI; a community
fork, qwen-code, reportedly carries the hook system forward with
multi-provider support — unverified, track it).

**ACP (Agent Client Protocol).** Not the binding layer. ACP is designed
to *replace* the agent's own TUI (the client renders everything from
`session/update` notifications) — adopting it for interactive workers
means garden would have to render each agent's UI itself, surrendering
requirement 2. It also does not standardize transcripts, credentials,
model selection, or (yet) usage. Where it may earn a place later: a
headless ACP client as a *fallback adapter* for harnesses garden has no
native adapter for. Track it; do not build on it now.

## Architecture

Three layers, introduced bottom-up. Each maps onto an existing garden
pattern so the codebase stays one idiom.

### Layer 1: provider descriptors (Axis 1)

A **provider** describes a backend reachable through the Anthropic
Messages protocol. Providers are a sibling of the existing
`claudeProfiles` concept, not a mutation of it — `claude-profile` remains
the OAuth-only special case. As implemented (`config.ts`):

```ts
interface ProviderProfile {
  baseUrl: string;           // ANTHROPIC_BASE_URL for sessions on this provider
  authTokenEnv: string;      // env var NAME holding the key; never the key itself
  label?: string;
  // What the model aliases resolve to on this backend (ANTHROPIC_DEFAULT_*_MODEL).
  modelMap?: { opus?: string; sonnet?: string; haiku?: string };
  // Extra sandbox egress hosts beyond the baseUrl host (allowed automatically).
  egressHosts?: string[];
}
```

The legal invariant is structural: a provider is API-key-backed by
construction — the type has no field that could reference a subscription
OAuth credential, so OAuth can never be combined with a custom base URL.
API keys are referenced by env var name (no-secrets-in-config), validated
against a strict env-var-name regex because the name is interpolated into
launch commands as an unexpanded `"$NAME"` shell reference — expanded at
spawn time, so the key value never appears in config.yml, tmux command
lines, or ps output. A Bedrock/Vertex `cloud-iam` shape
(`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`) is expressible
later as a sibling field set; out of scope through Phase 5.

**Key delivery.** The `"$NAME"` reference expands in the environment the
tmux server gives the pane — frozen at server start, not the operator's
later shells. Garden bridges this explicitly: the operator-shell entry
points (`provider add`, `config set provider`, dashboard create/attach,
`workers new`, `auth status`) push the key from the CLI process into the
dashboard's tmux **session environment** (`tmux set-environment`), where
it persists for the server's lifetime and reaches every later
respawn/bounce/loop launch. `workers new` preflights: a provider-backed
worker whose key is in neither this shell nor the session env is refused
with a concrete message rather than launched unauthenticated. `garden
auth status` reports both locations and heals on read (it syncs from the
shell it runs in), so it is both the diagnostic and the fix.

Operator surface (implemented; the `workers new --provider` per-worker
override is Phase 2):

```
garden provider add deepseek \
  --base-url https://api.deepseek.com/anthropic \
  --token-env DEEPSEEK_API_KEY \
  --map opus=deepseek-v4-pro,sonnet=deepseek-v4-flash \
  [--egress host1,host2] [--label <label>]
garden provider list | remove <name>
garden config <project> provider <name>          # project default; unset to clear
```

`garden login <provider>` prints guidance instead of a login flow
("export DEEPSEEK_API_KEY in the shell that starts garden") — the
Keychain capture, refresh, and displacement machinery in
`login.ts`/`credentials.ts`/`auth.ts` applies only to OAuth profiles.
`garden auth status` reports a row per provider: presence/absence of the
named env var in the current shell, no expiry or Keychain semantics.

What changes to consume this:

- `claude-env.ts` generalizes from "maybe emit `CLAUDE_CONFIG_DIR`" to
  "emit the provider's env map" (`ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_*_MODEL` from `modelMap`,
  or `CLAUDE_CONFIG_DIR` for first-party).
- **The worker's provider is not the reviewer's provider.** Reviewer,
  resolver, and ci-fix stay on the project's first-party Anthropic path
  *regardless of the worker's provider*, and for provider-backed
  projects the reviewer is pinned to Opus (`poller-review.ts`) rather
  than inheriting the account default. This is enforced actively, not by
  absence: `reviewerEnvPrefix` (`claude-env.ts`) prepends empty-string
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_DEFAULT_*_MODEL`
  assignments for provider-backed projects, so provider env inherited
  from the tmux server (an operator following DeepSeek/Ollama setup
  guides may export those globally) cannot silently route the reviewer
  through the worker's cheap backend. Only the trellis workflow pinned
  its reviewer before (WORKFLOWS.md Invariant 10 is trellis-scoped), so
  this was new work in Phase 1, not an existing guarantee. It is the
  safety net that makes cheap or experimental worker models safe to try:
  a DeepSeek worker reviewed by an Opus reviewer fails safe.
- `sandbox.ts` keeps the Anthropic domains unconditionally — the
  reviewer shares the worktree's settings.json — and unions in the
  provider's `baseUrl` host plus declared `egressHosts` for
  provider-backed projects (DeepSeek adds `api.deepseek.com`; a local
  Ollama adds `localhost`).
- The usage meter is gated, not generalized, in Phase 1: when every
  project runs on a provider, the usage poller and the Stop-hook
  opportunistic refresh skip (no poller 401-ing api.anthropic.com every
  backoff window), and the title pane says why instead of "loading…".
  The neutral `Meter[]` render seam, the auto-continue threshold gate,
  and the trellis Sonnet-fallback all land in Phase 2 together with the
  model vocabulary they are entangled with (the latter two live in
  `trellis-model.ts`/`poller-merge.ts` against the legacy snapshot
  shape).

Everything else — hooks, status, transcripts, skills, review pipeline —
is provably untouched by Axis 1, because it is all client-side harness
behavior.

### Layer 2: the neutral core

Vocabulary changes that make the core harness-agnostic without changing
behavior. All are mechanical, all need the `readRegistry` legacy-shape
migration treatment:

- **`claudeStatus` → `agentStatus`** (and `lastHookAt` → `lastEventAt`) — applied.
  The vocabulary `{loading, ready, working, asking, idle, exited}` is
  already harness-neutral; only the name and the writers are
  Claude-shaped. Writers to re-key: the hook handlers, the pane-died
  handler (`header.ts`), `validate.ts` reconciliation, and the
  bounce/attach paths that write `idle` directly.
- **Normalized lifecycle events.** Garden's internal event set, which the
  status machine and `WorkflowHookHandlers` re-key against:

  | Garden event | Claude Code source | Drives |
  |---|---|---|
  | `session-start(source)` | SessionStart hook | `ready`/preserve-on-resume |
  | `prompt-submitted` | UserPromptSubmit hook | `working`, clears sentinels/`merged` |
  | `turn-ended` | Stop hook; adapters also fire it from the pane-exit shim (today `_claude-hook stop` appended to launch commands) as a best-effort flush on graceful exit | `idle`, commits-ahead check, review entry |
  | `blocked-on-operator` | PermissionRequest / PreToolUse matchers / Notification | `asking` |
  | `tool-activity` | PostToolUse | heartbeat, self-heal `asking`→`working` |
  | `exited` | tmux pane-died handler (not a harness event) | `exited`, interrupt capture |

  The dispatcher-to-workflow interface speaks only these events; each
  adapter translates its native payload into them. For Claude Code the
  translation is what `hook-entry.ts`/`hook-dispatcher.ts` already do
  (the settings.json command strings shorten the names before the
  dispatcher sees them).
- **Opaque model strings.** Every `"opus" | "sonnet"` union
  (`workflows/types.ts`, `registry.ts`, `create.ts`, `trellis-model.ts`,
  `commands/workers.ts`) widens to `string`; `--model` is accepted on
  every workflow (persisted to `WorkerEntry.model` for default/grow,
  `trellis.workerModel` for vines, threaded through bounce/resume/
  respawn). Trellis's Sonnet-exhaustion fallback engages only for the
  literal "sonnet" alias and is skipped entirely for provider-backed
  projects (the Anthropic meter says nothing about the backend the
  alias maps to there). Model *intent* tiers — `workhorse` (cheap
  default) vs `quality` (pinned reviewer), resolved per launch through
  the provider's `modelMap` — and the per-worker `--provider`/
  `--harness` flags are Phase 3 work alongside the adapter interface
  they parameterize.
- **`Turn[]` as the transcript contract.** The seam in `conversation.ts`
  is two-part and both halves become adapter-supplied:
  `resolveTranscriptPath(entry)` (path derivation) and
  `readConversation(path) → Turn[]` (parse). The `Turn` model (user
  prompt | assistant turn tagged worked/planned/answered) is the stable
  interface; `formatConversationPane` is already neutral.

### Layer 3: harness adapters (Axis 2)

A registry of `HarnessAdapter` definitions mirroring the workflow
registry (`workflows/index.ts`) — data records plus functions, resolved
by name, with `claude-code` as the default and the reference
implementation:

```ts
interface HarnessAdapter {
  name: string;                          // "claude-code" | "codex" | "opencode"
  // Session identity. claude-code mints a UUID garden passes via
  // --session-id; codex assigns its own id, recovered after launch.
  allocateSessionId(): string | null;
  recoverSessionId(entry: WorkerEntry): string | null;
  // Launch: collapses create.ts's five builders into two. LaunchOptions
  // carries the resolved concrete model for this launch. The returned
  // command includes the harness's pane-exit turn-end shim.
  buildLaunchCommand(opts: LaunchOptions): string;   // new session
  buildResumeCommand(opts: LaunchOptions): string;   // resume (capability-gated)
  // Worktree provisioning: settings/hooks/skills/rules delivery.
  installRuntimeConfig(worktree: string, project: ProjectConfig): void;
  // Live prompt delivery into the pane (claude-code: pasteAndSubmit's
  // paste-then-Enter contract; other TUIs supply their own).
  deliverPrompt(paneId: string, text: string): void;
  // Headless one-shot (reviewer/resolver/ci-fix).
  buildHeadlessCommand(opts: HeadlessOptions): string;
  isTransientError(outputTail: string): boolean;
  // Transcript.
  resolveTranscript(entry: WorkerEntry): TranscriptHandle | null;
  readTurns(handle: TranscriptHandle, max: number): Turn[];
  // Provider/credential env for a session in this harness.
  sessionEnv(project: ProjectConfig, profile: ProviderProfile): Record<string, string>;
  // What this harness can and cannot signal.
  capabilities: {
    turnEnd: true;                 // required; non-negotiable (see tiers)
    promptSubmitted: boolean;      // sentinel-clear + delivery confirmation
    toolActivity: boolean;         // working heartbeat + stale detection
    askingSignal: boolean;         // the `asking` status
    resume: boolean;               // bounce/recovery; false = cold restart
    sandbox: boolean;              // harness-enforced sandbox available
    skills: boolean;               // native skill mechanism; false = fold into rules
  };
}
```

Notes pinned down by the audit:

- **Event delivery is the adapter's problem, normalized events are the
  contract.** Claude Code: settings.json hooks → `dist/hook.js` (today's
  path, unchanged). Codex: lifecycle hooks injected as `-c` overrides on
  the worker launch (`codexHookFlags`) — a worktree-local `.codex/hooks.json`
  does not fire, since Codex resolves project hooks at the repo root — same
  stdin-JSON shape, near-identical event names, so the Codex shim is a thin
  payload translation, with `notify` as redundant turn-end insurance. opencode: a bundled plugin emitting the five events. The
  FIFO, the dispatcher interface, and the status machine do not change
  per harness. No adapter may introduce polling to synthesize an event
  it lacks — a missing capability is declared, not papered over
  (STATUS.md's no-polling invariant binds adapters too).
- **`installRuntimeConfig` owns the config-file dialect**:
  `.claude/settings.json` + `.claude/skills/` for Claude;
  `CODEX_HOME/config.toml` directory-trust + `AGENTS.md` for Codex
  (rules text written to `AGENTS.md`; skills folded into the rules text
  when `capabilities.skills` is false; the lifecycle hooks ride `-c` launch
  overrides, not a config file); `opencode.json` + plugin +
  `AGENTS.md` for opencode. The rules *content* (`rules.ts`) stays
  shared; the small number of Claude-specific phrasings in it ("invoke
  the done skill", ".claude/skills/done/SKILL.md") become template
  variables the adapter fills. A worktree may carry multiple harness
  dialects side by side — see mixed fleets below.
- **Sandbox is a capability, not a given.** Claude and Codex both
  enforce their own; the shared `buildSandboxConfig` computation
  (writable roots + egress hosts) stays, and the adapter serializes it
  into its harness's dialect. A harness with `sandbox: false` is not
  eligible for autonomous workers — surfaced at `workers new` time, not
  discovered in production.
- **Headless agents install their own harness's config.** The reviewer
  runs with cwd inside the *worker's* worktree (`poller-review.ts`); a
  Claude reviewer in a Codex worker's worktree would find no
  `.claude/settings.json` — no hooks (fine) but also **no sandbox** (not
  fine). The headless launch path therefore runs the *agent's own*
  adapter's `installRuntimeConfig` before launch, unconditionally. The
  `GARDEN_REVIEWER=1` suppression stays for the same-harness case, owned
  by the adapter's event shim.
- **Session identity is harness-shaped.** `loop.ts`'s
  cold-respawn-per-iteration currently mints a fresh UUID via
  `crypto.randomUUID` and hands it to `--session-id`; Codex assigns its
  own session ids. The respawn dance routes through
  `allocateSessionId`/`recoverSessionId` so both contracts fit.
- **Where identity lives**: `WorkerEntry.harness?: string` (flat,
  defaulted to `"claude-code"`, exactly like the existing `workflow`
  field) and `WorkerEntry.provider?: string` (`WorkerEntry.model` already
  landed in Phase 2 with the per-worker `--model` override).
  Per-project defaults: `garden config <project> harness` / `provider` /
  `model`. Per-worker override at `workers new`. Anything a harness
  accumulates per worker goes in a sub-object (`entry.codex?: {...}`)
  per the established per-workflow-data pattern.

### Capability tiers and degradation policy

Garden refuses to silently degrade. Each adapter's capability flags place
it in a tier, displayed in the status pane and enforced at spawn time:

- **Tier A (full parity)**: all events. claude-code today; Codex lands
  here via `hooks.json` with one documented caveat — its
  PreToolUse/PostToolUse coverage has gaps (not all shell calls, no
  WebSearch-class tools), so the working heartbeat is partial and
  `health`'s stale thresholds need to tolerate it; opencode is
  architecturally capable via its event bus.
- **Tier B (turn-end + partial)**: `turn-ended` native, some of
  working/asking/prompt-submitted missing. Tier B costs: `asking` never
  shows (auto-approval makes it rare anyway), stale-detection
  (`health.ts`) uses coarser signals, prompt delivery confirmation falls
  back to pane-content checks.
- **No tier (rejected)**: a harness with no turn-end signal cannot run
  workers. STATUS.md's no-polling invariant is preserved by refusing the
  harness, not by polling around it. aider and goose sit here today.

### Mixed fleets and the review pipeline

Worker harness/provider and reviewer harness/provider are independent
choices. The review pipeline defaults to Claude on a strong model
regardless of what the worker runs (new work, Phase 1 — see Layer 1),
because reviewer quality is the safety net that makes cheap or
experimental worker models safe to try. The verdict contract
(`parseLastLineVerdict`) is plain text and already provider-agnostic.
Per-project config can relax the reviewer pinning once a foreign model
earns trust.

## What does not change

For confidence in scoping: the tmux layout/swap-pane machinery, hidden
windows, the poller and its FIFO, `prState` and `transitionState`, the
merge queue, CI gate, resolver/ci-fix state machines, git/worktree
bootstrap scaffolding, atomic writes and type-guarded readers, alert
dedup, plots, logs, hotkeys, and all prompt prose. The refactor threads
new seams through existing chokepoints; it does not move them.

## Migration across phases

Workers pin their launch command, settings/hook routes, and env at
creation time. Config changes (provider/harness/model) therefore apply
to newly created or bounced workers only; live workers keep their pinned
contract until recreated — the same staleness model the dashboard
already has for rebuilds. The Phase 2 rename pairs the `readRegistry`
migration with a transition window in which live workers still writing
`agentStatus` are read correctly. Rollback at every phase is "remove
the config key": running workers are unaffected and new workers fall
back to the Claude-only defaults.

## Phased plan

Each phase independently reviewable and mergeable; later phases assume
earlier ones merged. Every phase updates DESIGN.md + CLAUDE.md for any
command/config/architecture surface it changes, and re-fixtures the
tests it touches — that is part of the phase, not adjacent work.
Phases 3-5 start only when the operator actually wants the foreign
harness they enable; the adapter interface earns its existence the way
the workflow registry did — with a second real consumer, not
speculatively.

**Phase 1 — provider layer (Axis 1). SHIPPED.** `ProviderProfile` +
`garden provider` command surface; worker env injection in
`claude-env.ts` (`workerEnvPrefix`); reviewer/resolver/ci-fix stay on the
Anthropic path with the reviewer pinned to Opus for provider-backed
projects; sandbox egress union; usage poller + hook refresh + pane gated
for provider-only fleets; structural OAuth exclusion (providers are
API-key-only by type); `provider` config key; `garden login`/`auth
status` behavior for providers. The auto-continue gate and trellis
fallback keep reading the legacy snapshot shape this phase. Delivered: a
project configured with a DeepSeek or Ollama provider runs workers
through the full review/merge cycle with a Claude reviewer, and the
meter pane is honest about what it can't see. Zero behavior change for
unconfigured projects.

**Phase 2 — neutral core. SHIPPED.** `claudeStatus` → `agentStatus`
rename with registry migration (lazy migrate-on-read, same pattern as
the trellis sub-object migration); normalized lifecycle event vocabulary
on `WorkflowHookHandlers` (`onTurnEnded` / `onPromptSubmitted` /
`onBlockedOnOperator` / `onToolActivity`), with the dispatcher's wire-name
switch as the Claude adapter's translation; opaque model strings
replacing the `"opus" | "sonnet"` unions, `--model` accepted on every
workflow and persisted (`WorkerEntry.model` for default/grow,
`trellis.workerModel` for vines) through respawn/bounce/resume; the
`snapshotMeters` neutral accessor feeding a provider-aware auto-continue
gate and trellis fallback (both inert for provider-backed work). The
per-worker `--provider` flag and model intent tiers moved to Phase 3 —
see the Status deviations. Pure refactor otherwise, bit-for-bit
behavior.

**Phase 3 — harness adapter extraction. SHIPPED.** `HarnessAdapter` interface +
registry; `claude-code` adapter as sole implementation; collapse the five
launch builders; route `launchHeadlessAgent`, `installClaudeHooks` (shipped as `installRuntimeConfig`),
transcript reading, prompt delivery, and credential env through the
adapter; `WorkerEntry.harness` field, plus the per-worker `--provider`
override and model intent tiers deferred from Phase 2 (they thread
through the same launch/resume/bounce/respawn sites the adapter owns). The workflows-registry refactor is
the precedent: same shape, same bit-for-bit bar, same test strategy
(`test/workflows.test.ts` analog plus integration tests on real fs/git).

**Phase 4 — per-role resolution + Codex, reviewer-first. IN PROGRESS.**

The reframe (operator, 2026-06/07): garden should let *every role* in
*every workflow* independently resolve `(harness, provider, model)` —
arbitrary-per-role, opinionated-by-default — with Codex / DeepSeek / any
future model as interchangeable first-class instances. Roles are worker,
reviewer, resolver, ci-fix. The mechanism is a pure
`resolveRole(project, workflow, role) → {harness, provider, model}` that
resolves each dimension independently (first-defined-wins), fed by a
per-project `roles` sub-object (`garden config <p> role <role> <dim>
<value>`), with the flat `provider` key retained as the worker-provider
shortcut (zero migration). Defaults stay safe: reviewer/resolver/ci-fix
default to strong first-party Anthropic Opus; workers to the
account/backend default. Roles are structurally independent —
`resolveRole` reads only its own slot, so there is no shared-model knob
(the trap the operator reverted 2026-06-30).

The operator's primary use case is **Codex-as-reviewer** — a strong,
subsidized second-opinion reviewer over Claude or DeepSeek workers — so
the build is reviewer-first. Verified live 2026-07-01 (codex 0.142.5):
`codex exec` performs full agentic review — it found a planted bug,
fixed and committed it, and emitted a clean `FIXED` verdict on the last
line of stdout — so garden's `parseLastLineVerdict` contract holds
against Codex. Load-bearing details from that spike: the verdict is on
stdout, the token-count trailer on stderr, so Codex's headless command
captures stdout→result / stderr→sidecar (not `2>&1`, which would make
the token count the last line); `GARDEN_REVIEWER=1` suppression is
already harness-agnostic (checked in garden's hook entry), so a
cross-harness reviewer needs no new suppression; and the reviewer takes
its prompt on stdin, so the AGENTS.md-collision concern below is
worker-only.

Verified Codex facts (0.142.5): headless `codex exec --json
--output-schema --cd -m --sandbox --skip-git-repo-check`; interactive
`codex` Ratatui TUI; session identity is a Codex-assigned `thread_id`
(recovered post-launch, not minted — the one real divergence from
claude-code); transcript JSONL at
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl` (created
on first run); hooks via `.codex/hooks.json` (stdin-JSON payload carrying
`transcript_path`/`session_id`/`cwd`/`hook_event_name`, mapping 1:1 onto
garden's wire events) but trust-gated → `--dangerously-bypass-hook-trust`
is mandatory on the interactive worker launch for the event relay to
fire (the headless reviewer omits it, so Codex skips the untrusted
hooks — which is what a reviewer wants); rules via `AGENTS.md` (no
system-prompt flag); Codex enforces its own sandbox (`--sandbox` modes).

Reviewer-first slices (each independently mergeable, Claude fleet
byte-identical, full gate green):

- **Slice A — Codex adapter, headless-first (dormant). SHIPPED.**
  `codex-core.ts` (headless command with the stdout/stderr split;
  `isTransientError` for OpenAI/Codex shapes; capabilities; the light
  methods incl. the rollout `readTurns`) + `codex.ts`
  (`installRuntimeConfig` → `.codex/hooks.json`) + register in both
  registries. Selectable by nothing yet — the existing fleet is untouched.
- **Slices B+C — reviewer-role resolution → Codex-as-reviewer. SHIPPED**
  (landed together — a Codex reviewer needs no per-worktree config, which
  collapsed the drafted "headless installs its own config" work into the
  worker path). `resolveReviewRole(project, workflow, role)` in `roles.ts`
  independently resolves each review role's `{harness, model, envPrefix}`
  (no `provider` on review roles — a provider only ever defeats the safety
  net); the `garden config <p> role <role> harness|model` surface (strict
  harness validation); env is harness-aware (claude-code keeps the
  provider-neutralizing prefix, Codex gets none — it uses `~/.codex/auth`);
  the three review pollers route `harness`+`model`+`env` through
  `launchHeadlessAgent`; the transient-error check reads the Codex stderr
  sidecar; and reviewer, resolver, *and* ci-fix default to explicit Opus
  on the claude-code path (operator choice — a behavior change from the old
  provider-only Opus pin, each overridable). A Codex reviewer works because
  its prompt is delivered on stdin (no AGENTS.md), it authenticates itself
  (no env), and it omits `--dangerously-bypass-hook-trust` (fires no relay).
  Deferred to the worker path: a *claude* reviewer installing its own
  `.claude/` config into a *Codex worker's* worktree (only reachable once
  Codex workers exist) and the union git-excludes that go with it.

Then the **worker path** (second priority): interactive
`buildAgentCommand`, a spike proving Codex fires `Stop` per-turn (the
poller's liveness poke), session-identity recovery across
newWorker/loop/bounce/resume, `--harness` worker selection with a runtime
capability gate, the bootstrap config-install seam (stop inlining the
claude dialect), the `continue.ts`/`header.ts`
`deliverPrompt`/`readTurns` routing, and the full per-role resolver for
the worker. AGENTS.md-collision handling (never clobber a repo's own
`AGENTS.md`) and Codex sandbox/network translation live here.

Resolved decisions: Codex-reviewer is primary and *not* Claude-locked;
all three review roles default to explicit Opus; worker-provider stays
single-source (the flat `provider` key — no higher-precedence
`roles.worker.provider` split-brain); a provider on a non-claude-code
role is rejected in v1 (`ProviderProfile` is an `ANTHROPIC_*` env-swap
descriptor that cannot describe a Codex backend); review-family knobs are
project-config-only (no per-worker reviewer flag).

**Phase 5 — Codex worker completion + opencode + fleet polish (on
demand).** The Codex worker path above, then opencode (Tier A via its
event bus) for open-source breadth beyond Ollama-behind-Claude, plus
mixed-fleet `health`/`validate` and per-provider meters. Build when a
concrete need appears.

## Risks and open questions

- **Model quality in autonomous loops.** Garden's worker discipline
  (commit/push/end-turn, no side branches, sentinel files) is prompt-
  enforced; weaker models will violate it more. The reviewer safety net
  covers correctness but not wasted cycles. Mitigation: start foreign
  models on small scoped tasks; keep the reviewer pinned strong.
- **Tool-call fidelity.** DeepSeek v4-pro has a documented intermittent
  tool-calls-as-plain-text bug. Ollama's local tool-call parsing has had
  recurring model-specific bugs (the Qwen3-Coder parser mis-routing was
  fixed ~March 2026 in v0.17.3/.6; others remained open into April
  2026); cloud models avoid the local translation path, and the
  `/v1`-suffixed-base-URL streaming footgun is permanent configuration
  hygiene. The transient-error detector (`isTransientError`) and review
  retry budgets absorb some of this; empirical burn-in per provider is
  unavoidable.
- **Prompt-caching economics.** See the Layer 1 landscape note: Claude
  Code requests caching by default and DeepSeek ignores it; proxies
  generally lose Anthropic caching. Worker cost profiles need
  observation before heavy use.
- **Usage-gate blind spots.** API-key providers have no quota windows;
  the auto-continue gate goes inert for them. A spend-based gate
  (DeepSeek balance, token-count accumulation from transcripts) is a
  possible later addition; deliberately out of scope through Phase 5.
- **Landscape volatility.** Codex's rollout-JSONL schema is
  reverse-engineered, not contractual, and its hooks system is new;
  opencode's event names can move; DeepSeek's post-promo pricing and
  Ollama's quota surface are in flux. Re-verify the relevant facts at
  the start of each phase.
- **Open questions deferred to implementation**: whether Claude Code's
  meter/usage commands no-op gracefully against third-party base URLs;
  whether hooks fire identically under `-p` on the pinned CLI version
  (the headless path's event needs are minimal — the FIFO poke comes
  from the shell wrapper, not hooks, so exposure is low); Codex
  hooks.json firing semantics under `codex exec`; whether Codex's
  PostToolUse coverage gaps matter in practice for stale detection.
