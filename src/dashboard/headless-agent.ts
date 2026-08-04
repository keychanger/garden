// Headless agent primitive: launches a one-shot harness process in a hidden
// tmux window. Reviewer, resolver, and CI-fix callers share the same launch
// shape (write prompt, clean stale result, replace stale window, run the
// harness with prompt/result redirection, then poke the FIFO).
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
import type { HeadlessLaunchPlan } from "./harness/types.js";

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
  /** Validated role/backend/model/policy tuple. */
  launchPlan: HeadlessLaunchPlan;
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
  const agentCmd = getHarnessCore(opts.launchPlan.harness).buildHeadlessCommand({
    promptFile: opts.promptFile,
    resultFile: opts.resultFile,
    launchPlan: opts.launchPlan,
    inlineEnv,
  });
  const cmd = `${agentCmd}; [ -p ${escapedFifo} ] && (echo > ${escapedFifo}) 2>/dev/null`;

  newDashboardWindow(opts.windowName, "-c", opts.cwd, "bash", "-c", cmd);

  const launchedAt = Date.now();
  if (opts.onLaunched) opts.onLaunched();

  return { windowName: opts.windowName, launchedAt };
}
