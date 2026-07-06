// Headless agent primitive: launches a one-shot `claude -p` in a hidden tmux
// window. Used by the reviewer (poller-review.ts) and resolver (poller-resolve.ts)
// — both share the same launch shape (write prompt, clean stale result, kill
// stale window, tmux new-window with `claude -p < prompt > result; poke-fifo`).
// See WORKFLOWS.md Component 1 for the full contract.
//
// The primitive does NOT touch the registry, does NOT enforce timeouts, and
// does NOT parse the result. Callers handle workflow-specific bookkeeping
// (preReviewSha, transitionState, alerts), schedule timeout wake-ups via
// `onLaunched`, and pass the result file's contents to `parseLastLineVerdict`.
import fs from "node:fs";
import { atomicWriteFile } from "./atomic-write.js";
import { newDashboardWindow, windowExists, killWindowSafe, shellEscape } from "./tmux.js";
import { getHarnessCore } from "./harness/core.js";

export interface HeadlessAgentLaunchOptions {
  /** Working directory for the claude process (typically the worktree). */
  cwd: string;
  /** Hidden tmux window name. Killed first if it already exists. */
  windowName: string;
  /** Prompt content. Written to promptFile atomically. */
  prompt: string;
  /** Where to write the prompt file (caller picks the path). */
  promptFile: string;
  /** Where claude writes stdout+stderr. Cleaned before launch. */
  resultFile: string;
  /** Output of claudeEnvPrefix(project) — e.g. `CLAUDE_CONFIG_DIR=... `. May be empty. */
  envPrefix: string;
  /** Additional env vars set inline before the claude invocation. e.g. `{ GARDEN_REVIEWER: "1" }`. */
  envVars?: Record<string, string>;
  /** FIFO poked when the agent exits. The shell guard `[ -p $FIFO ]` covers
   *  the transient FIFO-absent window during poller restart cycles, so a
   *  launch racing with restart still loses the wakeup gracefully (no-op
   *  rather than error). Caller owns the FIFO's lifecycle. */
  signalFifo: string;
  /** Caller-provided callback invoked synchronously after the tmux window
   *  is created — typically schedules a delayed wake-up so the workflow's
   *  state handler can detect timeout on the next poll cycle. */
  onLaunched?: () => void;
  /** Model to pass to claude via `--model`. When set, the inline command
   *  becomes `claude -p --model <model> < prompt > result`. When unset
   *  (default reviewer, default resolver), no `--model` flag is passed
   *  and claude uses the account's default model. Opaque string (alias or
   *  concrete model id). The trellis reviewer always sets "opus" per
   *  WORKFLOWS.md Invariant 10 — reviewer quality is non-negotiable, so
   *  the model is pinned regardless of the worker's model or quota state. */
  model?: string;
  /** Harness adapter running this headless agent. Absent = claude-code.
   *  This is the AGENT's harness (reviewer/resolver/ci-fix), independent
   *  of the worker's — see docs/MULTI-MODEL.md "Mixed fleets". */
  harness?: string;
}

export interface HeadlessAgentLaunchResult {
  windowName: string;
  /** Caller can record this on the registry entry as the launch baseline
   *  (e.g. reviewStartedAt for timeout enforcement). */
  launchedAt: number;
}

export function launchHeadlessAgent(
  opts: HeadlessAgentLaunchOptions,
): HeadlessAgentLaunchResult {
  atomicWriteFile(opts.promptFile, opts.prompt);

  try { fs.unlinkSync(opts.resultFile); } catch { /* ignore */ }

  if (windowExists(opts.windowName)) {
    killWindowSafe(opts.windowName);
  }

  const escapedFifo = shellEscape(opts.signalFifo);
  const inlineEnv = opts.envVars
    ? Object.entries(opts.envVars).map(([k, v]) => `${k}=${shellEscape(v)} `).join("")
    : "";
  // The harness owns the agent invocation; the FIFO-poke suffix is garden's
  // completion signal and stays caller-composed.
  const agentCmd = getHarnessCore(opts.harness).buildHeadlessCommand({
    promptFile: opts.promptFile,
    resultFile: opts.resultFile,
    model: opts.model,
    envPrefix: opts.envPrefix,
    inlineEnv,
  });
  const cmd = `${agentCmd}; [ -p ${escapedFifo} ] && (echo > ${escapedFifo}) 2>/dev/null`;

  newDashboardWindow(opts.windowName, "-c", opts.cwd, "bash", "-c", cmd);

  const launchedAt = Date.now();
  if (opts.onLaunched) opts.onLaunched();

  return { windowName: opts.windowName, launchedAt };
}

