// Harness registry. Resolution mirrors the workflow registry: a worker's
// `entry.harness` names its adapter; absent means "claude-code" (the only
// registered adapter today — legacy entries predate the field). Unknown
// names fall back to the default rather than throwing: launch paths
// (dashboard attach, resume, bounce) must not abort wholesale on a
// hand-broken registry entry, matching tryResolveProvider's posture.
import { log } from "../log.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import type { HarnessAdapter } from "./types.js";

import { DEFAULT_HARNESS } from "./core.js";

export { DEFAULT_HARNESS };

const HARNESSES: Record<string, HarnessAdapter> = {
  [claudeCodeAdapter.name]: claudeCodeAdapter,
  [codexAdapter.name]: codexAdapter,
};

export function getHarness(name?: string): HarnessAdapter {
  const resolved = HARNESSES[name ?? DEFAULT_HARNESS];
  if (resolved) return resolved;
  log.warn("harness", "unknown harness name; falling back to default", {
    data: { name, fallback: DEFAULT_HARNESS },
  });
  return claudeCodeAdapter;
}
