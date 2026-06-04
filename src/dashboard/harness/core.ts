// Light harness registry: resolves HarnessCore (everything except
// installRuntimeConfig). Hook-bundle-reachable modules (headless-agent,
// pollers) import this one; CLI modules that install runtime config import
// getHarness from harness/index.ts. The split is organizational, not a
// topological barrier — the heavy adapter IS reachable from the hook
// entry's import graph via loop.ts/create.ts; dist/hook.js stays lean
// because package.json's "sideEffects": false lets esbuild shake the
// unused heavy methods. The bundle-size guard test
// (test/integration/hook-bundle.real.test.ts) fails if that shaking ever
// stops working. Resolution semantics match getHarness: absent =
// claude-code, unknown falls back with a warning.
import { log } from "../log.js";
import { claudeCodeCore } from "./claude-code-core.js";
import type { HarnessCore } from "./types.js";

export const DEFAULT_HARNESS = "claude-code";

const CORES: Record<string, HarnessCore> = {
  [claudeCodeCore.name]: claudeCodeCore,
};

export function getHarnessCore(name?: string): HarnessCore {
  const resolved = CORES[name ?? DEFAULT_HARNESS];
  if (resolved) return resolved;
  log.warn("harness", "unknown harness name; falling back to default", {
    data: { name, fallback: DEFAULT_HARNESS },
  });
  return claudeCodeCore;
}
