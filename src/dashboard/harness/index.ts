// Full harness registry. Absent means "claude-code" for legacy entries.
// Unknown names retain a best-effort fallback for non-execution callers, but
// production launch paths resolve through launch-plan.ts first and therefore
// fail closed before calling this function.
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
