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

// Is this a registered harness name? Config-set paths validate STRICTLY with
// this (reject an unknown harness at the operator surface) rather than relying
// on getHarnessCore's launch-time warn-fallback. Launch paths keep the
// fallback for resilience; the operator surface should fail loudly.
export function isRegisteredHarness(name: string): boolean {
  return name in CORES;
}

export function harnessNames(): string[] {
  return Object.keys(CORES);
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
