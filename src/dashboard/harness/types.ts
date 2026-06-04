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
  /** Pre-composed env-assignments prefix (provider/profile env from
   *  claude-env.ts). Already shell-safe; prepended verbatim. */
  envPrefix: string;
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
