// Harness adapter types. A HarnessAdapter is a data record that owns every
// agent-CLI-specific decision garden makes: how the binary is invoked
// (interactive, resume, headless), how its runtime config reaches the
// worktree, how prompts are delivered to its TUI, how its transcript is
// read, and which lifecycle capabilities it can signal. The dispatcher,
// pollers, and state machine stay harness-agnostic — they speak the
// normalized lifecycle events on WorkflowHookHandlers and the option types
// below. Mirrors the workflow registry pattern (workflows/types.ts).
// See docs/MULTI-MODEL.md "Layer 3: harness adapters".
import type { ProjectConfig } from "../../config.js";
import type { WorkerEntry } from "../registry.js";
import type { Turn } from "../conversation.js";

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
  /** Opaque model string (alias or concrete id). Absent = the account
   *  or backend default. */
  model?: string;
  /** Ultracode preset: launch in Claude Code's ultracode mode (max effort +
   *  the dynamic-workflow keyword trigger). Absent/false = normal launch.
   *  The paired Opus model pin is threaded separately via `model`. */
  ultracode?: boolean;
  /** Reasoning-effort rung (one of WORKER_EFFORT_LEVELS) — claude-code
   *  renders `--effort <level>`. Independent of `model`. Mutually exclusive
   *  with `ultracode` (which already fixes max effort); if both are set the
   *  adapter lets ultracode win. A harness without an effort dial ignores it. */
  effort?: string;
  /** Pre-composed env-assignments prefix (provider/profile env from
   *  claude-env.ts). Already shell-safe; prepended verbatim. */
  envPrefix: string;
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
  model?: string;
  /** Pre-composed provider/profile env prefix. */
  envPrefix: string;
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
}

export interface HarnessAdapter extends HarnessCore {
  /** Write the harness's runtime config into the worktree: hook/event
   *  registration, sandbox, permissions, bundled skills — whatever the
   *  harness reads. Idempotent; called at bootstrap, refresh, bounce,
   *  and loop respawn. CLI-bundle only — see HarnessCore. */
  installRuntimeConfig(worktree: string, project: ProjectConfig): void;
}
