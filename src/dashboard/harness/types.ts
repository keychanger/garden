// Harness adapter types. A HarnessAdapter is a data record that owns every
// agent-CLI-specific decision garden makes: how the binary is invoked
// (interactive, resume, headless), how its runtime config reaches the
// worktree, how prompts are delivered to its TUI, how its transcript is
// read, and which lifecycle capabilities it can signal. The dispatcher,
// pollers, and state machine stay harness-agnostic — they speak the shared
// normalized lifecycle events on WorkflowHookHandlers and the option types
// below.
// See docs/MULTI-MODEL.md "Layer 3: harness adapters".
import type { ProjectConfig, ResolvedProvider } from "../../config.js";
import type { WorkerEntry } from "../registry.js";
import type { Turn } from "../conversation.js";

export type HeadlessRole = "reviewer" | "resolver" | "ciFix";

export type LaunchBackend =
  | { kind: "harness-account" }
  | { kind: "anthropic-compatible"; provider: string; baseUrl: string };

export type LaunchCredentialReference =
  | { kind: "harness-account" }
  | {
      kind: "tmux-hidden-environment";
      variable: string;
      sourceEnvironment: string;
    };

export interface WorkerLaunchPlan {
  role: "worker";
  harness: string;
  backend: LaunchBackend;
  credential: LaunchCredentialReference;
  model?: string;
  ultracode?: boolean;
  effort?: string;
  envPrefix: string;
  executionPolicy: "sandboxed-worker";
  requiredCapabilities: {
    turnEnd: true;
    sandbox: true;
    workflow: string;
    resume: boolean;
    providerProfiles: boolean;
  };
  /** Project view with a per-worker provider override already applied. */
  runtimeProject: ProjectConfig;
  /** Resolved profile used by the credential launch chokepoint. Never carries
   *  the credential value, only its configured source name. */
  resolvedProvider: ResolvedProvider | null;
}

export interface HeadlessLaunchPlan {
  role: HeadlessRole;
  harness: string;
  backend: { kind: "harness-account" };
  credential: { kind: "harness-account" };
  model?: string;
  effort?: string;
  envPrefix: string;
  executionPolicy: "trusted-headless";
  requiredCapabilities: { headlessRole: HeadlessRole };
}

export interface AgentCommandOptions {
  /** Session identifier — minted by allocateSessionId for new sessions,
   *  read from the entry for resume. */
  sessionId: string;
  /** Resume the identified session instead of starting fresh. Callers
   *  gate on capabilities.resume. */
  resume: boolean;
  /** Path to the composed rules/system-prompt file (rules.ts output).
   *  The adapter owns the delivery mechanism — a flag for Claude Code,
   *  an AGENTS.md or prompt prefix for harnesses without one. */
  contextFile: string;
  /** Validated identity/backend/policy tuple for this launch. */
  launchPlan: WorkerLaunchPlan;
  /** Absolute path to the worktree's shared git common dir (`<main>/.git`).
   *  A harness whose sandbox does not auto-grant the git dir (Codex
   *  workspace-write) adds it to its writable roots so the worker can
   *  commit/push — the git store sits outside the worktree cwd. claude-code
   *  ignores it (its sandbox layer grants the git dir automatically). Absent
   *  when the caller has no worktree context (e.g. the ad-hoc project-dir
   *  launch) or the harness does not need it. */
  worktreeGitDir?: string;
}

export interface HeadlessCommandOptions {
  /** Prompt content file, fed to the agent (stdin for Claude Code). */
  promptFile: string;
  /** Where the agent's stdout+stderr land for verdict parsing. */
  resultFile: string;
  /** Validated review-role identity/backend/policy tuple for this launch. */
  launchPlan: HeadlessLaunchPlan;
  /** Inline env assignments (e.g. `GARDEN_REVIEWER=1 `), pre-escaped. */
  inlineEnv: string;
}

// What a harness can signal. turnEnd is typed `true`: a harness without a
// turn-end signal cannot run workers at all — STATUS.md's no-polling
// invariant is preserved by refusing the harness, not polling around it
// (docs/MULTI-MODEL.md "Capability tiers").
export interface HarnessCapabilities {
  turnEnd: true;
  promptSubmitted: boolean;
  toolActivity: boolean;
  askingSignal: boolean;
  resume: boolean;
  sandbox: boolean;
  skills: boolean;
  /** Can this harness consume Garden's ProviderProfile contract
   *  (ANTHROPIC_* routing), rather than merely choosing its own models? */
  providerProfiles: boolean;
  /** Worker workflows whose launch/resume semantics this adapter implements.
   *  Kept explicit and fail-closed so registering a harness does not silently
   *  opt it into future workflow protocols. */
  workerWorkflows: readonly string[];
  /** Review-family roles this adapter can execute headlessly. */
  headlessRoles: readonly HeadlessRole[];
}

// The light half of an adapter: everything reachable from the hook bundle.
// Split rationale: the adapter object retains every method it references,
// so the one heavyweight method (installRuntimeConfig — skills content,
// sandbox rendering, hook-runner resolution) lives on HarnessAdapter,
// which only CLI-bundle modules import. Hook-closure modules resolve
// HarnessCore via harness/core.ts.
export interface HarnessCore {
  name: string;
  capabilities: HarnessCapabilities;
  /** Mint a fresh session identifier the launch command will bind
   *  (Claude Code accepts a caller-supplied UUID; a harness that assigns
   *  its own ids would return a placeholder and recover the real id
   *  post-launch). */
  allocateSessionId(): string;
  /** The shell line that runs the agent interactively. Callers own the
   *  scaffolding around it (identity exports, exit shims, poll signals,
   *  fallback shell) — those are garden semantics, not harness dialect. */
  buildAgentCommand(opts: AgentCommandOptions): string;
  /** The shell command core for a one-shot headless agent (reviewer /
   *  resolver / ci-fix). The caller appends the FIFO-poke suffix and owns
   *  window lifecycle, timeouts, and verdict parsing. */
  buildHeadlessCommand(opts: HeadlessCommandOptions): string;
  /** Deliver a prompt into the agent's live TUI pane. */
  deliverPrompt(paneId: string, text: string): void;
  /** Does this output tail look like a transient backend error (worth a
   *  retry) rather than an agent failure? Provider/API-shaped. */
  isTransientError(outputTail: string): boolean;
  /** Did the agent hit a session/usage QUOTA cutoff (distinct from a transient
   *  blip — this needs an hours-scale wall-clock wait for the operator's window
   *  to reset, not a seconds retry)? Returns `null` when it is NOT a quota
   *  cutoff; a non-null string (possibly "") when it IS — the string is a human
   *  reset hint for the alert (e.g. "3:40pm"). Callers MUST test `=== null`,
   *  never truthiness, since "" is a hit with no parseable reset time. */
  quotaLimitResetHint(outputTail: string): string | null;
  /** Locate the on-disk transcript for the history view. */
  resolveTranscriptPath(entry: WorkerEntry): string | null;
  /** Parse the transcript into the neutral Turn[] model. */
  readTurns(transcriptPath: string | null, maxTurns?: number): Turn[];
  /** The worker's "what am I doing" summary for the status pane's detail
   *  column, for a harness that does NOT paint one into its terminal title.
   *  Claude Code does (it rewrites the title as it works), so it omits this
   *  and garden reads the pane title; Codex's title items are metadata and
   *  counters only, so it derives the summary from its own transcript.
   *
   *  Defining it makes the harness AUTHORITATIVE over the field: a null
   *  return means "nothing to say right now, keep the previous summary",
   *  NOT "fall back to the pane title" — for such a harness the pane title
   *  is known-useless (Codex paints the worktree directory name, which is
   *  the worker name garden already renders in its own column).
   *
   *  Called from the status render paths and the hook path, so it must stay
   *  bounded — tail-read the transcript, never parse it whole. */
  readActivity?(entry: WorkerEntry): string | null;
  /** Does this pane's text show the harness's TUI booted and accepting a
   *  prompt? Defined only by a harness whose SessionStart-equivalent hook
   *  fires at the first TURN rather than at boot, which makes garden's
   *  `agentStatus === "loading"` self-clearing assumption circular: nothing
   *  clears "loading" until a prompt lands, and the seed path waits for
   *  "loading" to clear before sending one. Codex is such a harness (verified
   *  2026-08-25: its SessionStart arrived 0.6s AFTER the seed paste and 3min
   *  after launch), so it probes its own empty-composer signature instead.
   *
   *  Omitting it keeps the default behavior (wait on agentStatus alone), and
   *  the caller passes the pane text as a thunk, so a harness that omits it
   *  never pays a capture-pane fork. Consulted ONLY while a worker is still
   *  "loading" and has therefore never been prompted, so the pane holds the
   *  harness's own boot output and nothing a conversation could forge. */
  promptReady?(paneText: string): boolean;
}

export interface HarnessAdapter extends HarnessCore {
  /** Write the harness's runtime config into the worktree: hook/event
   *  registration, sandbox, permissions, bundled skills — whatever the
   *  harness reads. Idempotent; called at bootstrap, refresh, bounce,
   *  and loop respawn. CLI-bundle only — see HarnessCore. */
  installRuntimeConfig(
    worktree: string,
    project: ProjectConfig,
    runtime?: { rulesText?: string },
  ): void;
}
