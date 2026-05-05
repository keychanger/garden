// Workflow registry: lookup of WorkflowDefinition by name. Unknown names
// warn and fall back to the default workflow — matches transitionState's
// warn-on-invalid-transition pattern (registry consistency bugs surface in
// logs without breaking production).
import { log } from "../log.js";
import { defaultWorkflow } from "./default.js";
import type { WorkflowDefinition } from "./types.js";

export type { WorkflowDefinition, StateHandler, HookContext, WorkflowHookHandlers, HookMethod } from "./types.js";
export { defaultWorkflow } from "./default.js";

const registry = new Map<string, WorkflowDefinition>();
registry.set(defaultWorkflow.name, defaultWorkflow);

// Tracks names we've already warned about, so the operator's logs aren't
// spammed by every poll cycle on the same stale registry entry.
const warnedUnknown = new Set<string>();

export function getWorkflow(name: string): WorkflowDefinition {
  const workflow = registry.get(name);
  if (workflow) return workflow;
  if (!warnedUnknown.has(name)) {
    warnedUnknown.add(name);
    log.warn("workflows", "unknown workflow, falling back to default", {
      data: { requested: name },
    });
  }
  return defaultWorkflow;
}

export function registerWorkflow(def: WorkflowDefinition): void {
  // Duplicate-name registration is almost always a bug — a plug-in shadowing
  // an existing workflow (including "default") with no log line makes the
  // override invisible. Warn but allow, since tests legitimately re-register
  // names within a single process.
  if (registry.has(def.name)) {
    log.warn("workflows", "workflow already registered, overwriting", {
      data: { name: def.name },
    });
  }
  registry.set(def.name, def);
}

// Test-only: clears the unknown-warning dedup so a follow-up
// getWorkflow(name) call emits a fresh warning. Not part of the public
// surface used by production code.
export function _resetUnknownWarnDedup(): void {
  warnedUnknown.clear();
}
