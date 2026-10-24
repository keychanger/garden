// The Claude Code hook-event table (harness/claude-code-hooks.ts) is where
// garden decides what each event Claude Code fires does. These hold the table
// to Claude Code's catalog, every row to a disposition, and the hooks garden's
// settings file registers to the table.
import { describe, it, expect } from "vitest";
import { buildSettingsJson } from "../src/dashboard/harness/claude-code.js";
import { CLAUDE_HOOK_EVENTS, type ClaudeHookRegistration } from "../src/dashboard/harness/claude-code-hooks.js";
import { pickHookMethod } from "../src/dashboard/hook-dispatcher.js";
import { workerHookHandlers } from "../src/dashboard/hooks/default.js";

// Every hook event Claude Code 2.1.310 fires, in its own order, read from the
// hook schema in its CLI. Bringing this list up to a later release is what
// turns an event that release adds into a failure here until the table
// decides it.
const CLAUDE_CODE_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification",
  "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch",
  "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted",
  "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove",
  "InstructionsLoaded", "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay",
];

const MARKER = "/control/claude-settings/worker.unwatched";

interface WrittenGroup {
  matcher: string;
  hooks: { type: string; command: string; timeout: number }[];
}

function writtenHooks(): Record<string, WrittenGroup[]> {
  const settings = JSON.parse(buildSettingsJson("node /garden/dist/hook.js", { enabled: true } as never, "true", {
    unwatchedMarker: MARKER,
  }));
  return settings.hooks;
}

describe("Claude Code hook-event table", () => {
  it("names every event Claude Code fires, and nothing else", () => {
    expect(Object.keys(CLAUDE_HOOK_EVENTS).sort()).toEqual([...CLAUDE_CODE_EVENTS].sort());
  });

  // A registration on a route the dispatcher does not map starts node on every
  // fire and changes nothing, so it is no more a disposition than a blank reason.
  it("gives every event a disposition: routes the dispatcher maps, or the reason it is unregistered", () => {
    const undecided = Object.entries(CLAUDE_HOOK_EVENTS).filter(([, disposition]) => {
      const row = (disposition ?? {}) as { register?: unknown; unregistered?: unknown };
      const registrations = Array.isArray(row.register) ? row.register as Partial<ClaudeHookRegistration>[] : [];
      const registered = registrations.length > 0 && registrations.every(r =>
        typeof r.matcher === "string" && typeof r.timeout === "number" && r.timeout > 0
        && typeof r.route === "string" && typeof pickHookMethod(workerHookHandlers, r.route) === "function");
      const ruledOut = typeof row.unregistered === "string" && row.unregistered.trim() !== "";
      return registered === ruledOut;
    }).map(([event]) => event);
    expect(undecided).toEqual([]);
  });

  it("is exactly what garden's settings file registers, group for group", () => {
    const fromSettings = Object.fromEntries(Object.entries(writtenHooks()).map(([event, groups]) => [
      event,
      groups.map(group => ({
        matcher: group.matcher,
        hookCount: group.hooks.length,
        type: group.hooks[0]?.type,
        route: group.hooks[0]?.command.split(" ").at(-1),
        timeout: group.hooks[0]?.timeout,
        skipsWhileUnwatched: group.hooks[0]?.command.includes(MARKER) ?? false,
      })),
    ]));
    const fromTable = Object.fromEntries(Object.entries(CLAUDE_HOOK_EVENTS).flatMap(([event, disposition]) =>
      "register" in disposition
        ? [[event, disposition.register.map(r => ({
          matcher: r.matcher,
          hookCount: 1,
          type: "command",
          route: r.route,
          timeout: r.timeout,
          skipsWhileUnwatched: r.skipWhileUnwatched === true,
        }))]]
        : []));
    expect(fromSettings).toEqual(fromTable);
  });
});
