// Claude Code hook dispatcher. Wire events map onto the lifecycle handlers in
// hooks/default.ts. Hooks are shared by every shipped workflow: workflows vary
// in poller state handling, not in how agent activity updates worker state.
// Keeping that distinction explicit prevents this per-tool-call entrypoint
// from importing workflows/index.ts and retaining the entire poller graph.
//
// Reviewer/resolver hooks short-circuit here (GARDEN_REVIEWER=1) — they fire
// from the same worktree as the worker and would otherwise be indistinguishable.
import { workerHookHandlers, workerFromCwd, readHookInput } from "./hooks/default.js";
import { findWorkerByName } from "./registry.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
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

  const method = pickHookMethod(workerHookHandlers, event);
  if (!method) {
    // debug, not warn: this fires once per hook invocation (a separate
    // short-lived process each time, so no in-process dedup can throttle it).
    // The known cause — a stale session firing the old `dashboard _claude-hook`
    // arg shape — is now recovered in hook-entry.ts, so a value reaching here is
    // either a genuinely new Claude hook type or a malformed manual call;
    // neither warrants a warn-level firehose. GARDEN_LOG_LEVEL=debug to surface.
    log.debug("hook", "unhandled claude hook event", {
      worker: cwdInfo.worker,
      data: { project: cwdInfo.project, event, workflow: entry.workflow ?? "default" },
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
