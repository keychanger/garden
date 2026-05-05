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
    log.warn("hook", "unknown claude hook event", {
      worker: cwdInfo.worker,
      data: { project: cwdInfo.project, event, workflow: workflow.name },
    });
    return;
  }
  method(ctx);
}

function pickHookMethod(handlers: WorkflowHookHandlers, event: string): HookMethod | null {
  switch (event) {
    case "sessionstart": return handlers.onSessionStart;
    case "prompt":       return handlers.onUserPromptSubmit;
    case "stop":         return handlers.onStop;
    case "notification": return handlers.onNotification;
    case "pretooluse":   return handlers.onPreToolUse;
    case "posttooluse":  return handlers.onPostToolUse;
    default:             return null;
  }
}
