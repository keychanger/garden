// Claude Code hook dispatcher: looks up the worker's workflow and routes the
// event to the appropriate hookHandlers method. Per-event behavior lives in
// the workflow's hookHandlers (default workflow's are in hooks/default.ts).
//
// Why this is its own file (and not inside header.ts where it used to live):
// header.ts is imported by hooks/default.ts for findWorkerPaneId/refreshDashboard.
// If header.ts also imported `getWorkflow` from workflows/index.ts, the chain
// `workflows/default.ts → hooks/default.ts → header.ts → workflows/index.ts →
// workflows/default.ts` closed a module-init cycle that crashed every Claude
// Code hook with "Cannot read properties of undefined (reading 'onStop')"
// under esbuild's bundling order. Splitting the dispatcher off keeps header.ts
// free of any workflows imports and lets defaultWorkflow.hookHandlers go back
// to a captured value (no getter).
//
// Reviewer/resolver hooks short-circuit here (GARDEN_REVIEWER=1) — they fire
// from the same worktree as the worker and would otherwise be indistinguishable.
import { workerFromCwd, readHookInput } from "./hooks/default.js";
import { findWorkerByName } from "./registry.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import { getWorkflow } from "./workflows/index.js";
import type { HookContext, HookMethod, WorkflowHookHandlers } from "./workflows/types.js";

export function handleClaudeHook(event: string): void {
  if (process.env.GARDEN_REVIEWER === "1") return;

  const cwdInfo = workerFromCwd();
  if (!cwdInfo) {
    // Hook fired from outside any worktree (operator ad-hoc invocation).
    // Nothing to update; refresh the dashboard so any stale state (e.g.,
    // unread alerts) gets repainted.
    refreshDashboard();
    return;
  }

  const entry = findWorkerByName(cwdInfo.project, cwdInfo.worker);
  if (!entry) {
    refreshDashboard();
    return;
  }

  const ctx: HookContext = {
    event,
    input: readHookInput(),
    workerInfo: { name: cwdInfo.worker, project: cwdInfo.project, entry },
  };

  const workflow = getWorkflow(entry.workflow ?? "default");
  const method = pickHookMethod(workflow.hookHandlers, event);
  if (!method) {
    // debug, not warn: this fires once per hook invocation (a separate
    // short-lived process each time, so no in-process dedup can throttle it).
    // The known cause — a stale session firing the old `dashboard _claude-hook`
    // arg shape — is now recovered in hook-entry.ts, so a value reaching here is
    // either a genuinely new Claude hook type or a malformed manual call;
    // neither warrants a warn-level firehose. GARDEN_LOG_LEVEL=debug to surface.
    log.debug("hook", "unhandled claude hook event", {
      worker: cwdInfo.worker,
      data: { project: cwdInfo.project, event, workflow: workflow.name },
    });
    return;
  }
  method(ctx);
}

// Wire events (the shortened Claude hook names baked into settings.json
// command strings) translate to garden's normalized lifecycle methods here.
// This switch IS the Claude Code adapter's event translation; a future
// harness adapter supplies its own mapping onto the same handler interface
// (docs/MULTI-MODEL.md "Layer 2").
function pickHookMethod(handlers: WorkflowHookHandlers, event: string): HookMethod | null {
  switch (event) {
    case "sessionstart": return handlers.onSessionStart;
    case "prompt":       return handlers.onPromptSubmitted;
    case "stop":         return handlers.onTurnEnded;
    case "notification": return handlers.onBlockedOnOperator;
    case "pretooluse":   return handlers.onBlockedOnOperator;
    case "posttooluse":  return handlers.onToolActivity;
    default:             return null;
  }
}
