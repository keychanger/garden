// Light harness registry: resolves HarnessCore (everything except
// installRuntimeConfig). Hook-bundle-reachable modules (headless-agent,
// pollers) import this one; CLI modules that install runtime config import
// getHarness from harness/index.ts. The split is organizational, not a
// topological barrier — the heavy adapter IS reachable from the hook
// entry's import graph via loop.ts/create.ts; dist/hook.js stays lean
// because package.json's "sideEffects": false lets esbuild shake the
// unused heavy methods. The bundle-size guard test
// (test/integration/hook-bundle.real.test.ts) fails if that shaking ever
// stops working. Absent names resolve to claude-code for legacy entries.
// Unknown names retain a best-effort fallback for status/read callers;
// execution paths first pass through launch-plan.ts and fail closed.
import { log } from "../log.js";
import type { WorkerEntry } from "../registry.js";
import { claudeCodeCore } from "./claude-code-core.js";
import { codexCore } from "./codex-core.js";
import type { HarnessCore } from "./types.js";

export const DEFAULT_HARNESS = "claude-code";

const CORES: Record<string, HarnessCore> = {
  [claudeCodeCore.name]: claudeCodeCore,
  [codexCore.name]: codexCore,
};

export function getHarnessCore(name?: string): HarnessCore {
  const resolved = CORES[name ?? DEFAULT_HARNESS];
  if (resolved) return resolved;
  log.warn("harness", "unknown harness name; falling back to default", {
    data: { name, fallback: DEFAULT_HARNESS },
  });
  return claudeCodeCore;
}

// The worker's status-pane summary, from whichever source its harness owns
// (HarnessCore.readActivity). A harness that reads its own activity is
// authoritative — the pane title is not consulted at all, and `paneTitle` is a
// thunk so its tmux forks are never paid for such a worker. Null from either
// source means "keep the previous summary"; every caller already treats a
// falsy result that way, since Claude Code leaves the title unset at session
// start and briefly after each prompt.
export function resolveWorkerActivity(
  entry: WorkerEntry,
  paneTitle: () => string | null,
): string | null {
  const core = getHarnessCore(entry.harness);
  return core.readActivity ? core.readActivity(entry) : paneTitle();
}

// Has this worker's harness painted a prompt-ready TUI? Only a harness whose
// boot signal is not its SessionStart hook defines the probe (see
// HarnessCore.promptReady); every other harness answers false and the caller
// falls back to its agentStatus check unchanged. `paneText` is a thunk so a
// harness without a probe never pays the capture-pane fork.
export function harnessSignalsPromptReady(
  harnessName: string | undefined,
  paneText: () => string | null,
): boolean {
  const core = getHarnessCore(harnessName);
  if (!core.promptReady) return false;
  const text = paneText();
  return text ? core.promptReady(text) : false;
}

// Is this a registered harness name? Config-set and launch-plan paths validate
// STRICTLY with this rather than relying on getHarnessCore's read-path
// fallback.
export function isRegisteredHarness(name: string): boolean {
  return name in CORES;
}

export function harnessNames(): string[] {
  return Object.keys(CORES);
}

export function workerLaunchCompatibilityError(
  harness: HarnessCore,
  requirements: { workflow: string; provider: string | null; resume?: boolean },
): string | null {
  if (!harness.capabilities.sandbox) {
    return `Harness '${harness.name}' does not provide a sandbox and cannot run autonomous workers.`;
  }
  if (!harness.capabilities.workerWorkflows.includes(requirements.workflow)) {
    return `Harness '${harness.name}' does not support workflow '${requirements.workflow}'.`;
  }
  if (requirements.provider && !harness.capabilities.providerProfiles) {
    return `Harness '${harness.name}' does not support provider profiles; provider '${requirements.provider}' requires a compatible harness.`;
  }
  if (requirements.resume && !harness.capabilities.resume) {
    return `Harness '${harness.name}' cannot resume sessions.`;
  }
  return null;
}

// Operator-facing harness aliases. The claude-code harness is named "claude"
// as a crew member (crew.ts) and reads better as "claude" wherever an operator
// types a harness name (`--harness claude`, `config <p> harness claude`), so
// accept it there. Canonicalize AT the input boundary — internal values stay
// registry names.
const HARNESS_ALIASES: Record<string, string> = { claude: DEFAULT_HARNESS };

// Resolve an operator-entered harness name to its registry name, passing
// through anything that is not a known alias so validation still rejects a
// genuine unknown.
export function canonicalHarnessName(name: string): string {
  return HARNESS_ALIASES[name] ?? name;
}
