// Every hook event Claude Code fires, each with garden's disposition: the wire
// route a registered event's command ends in, or why garden leaves the event
// unregistered. buildSettingsJson (claude-code.ts) writes the registered rows
// into garden's settings file and nothing else, and
// test/claude-code-hooks.test.ts fails when the written hooks and this table
// disagree, or when an event has neither a route nor a reason. The registered
// hooks used to be a hand-written object, where an event nobody had weighed
// looked the same as one ruled out: StopFailure was simply absent until a turn
// that died on a usage limit left its worker reading `working` for 39 hours.
//
// The rows are Claude Code 2.1.310's events. The test keeps its own copy of
// that catalog and fails until the table matches it, so bringing the catalog
// up to a later release forces a decision here for each new event.
//
// CLI only. The dispatcher in dist/hook.js keys on the route a command ends in
// and never reads this table; code the hook runs must not either, or the
// reasons below land in the per-tool-call bundle (hook-bundle.real.test.ts).

// The wire routes hook-dispatcher.ts maps onto the lifecycle handlers.
export type ClaudeHookRoute =
  | "sessionstart" | "prompt" | "stop" | "notification" | "pretooluse" | "posttooluse" | "toolstart";

export interface ClaudeHookRegistration {
  // A tool name for the tool events; "" matches every one.
  readonly matcher: string;
  readonly route: ClaudeHookRoute;
  // Seconds Claude Code waits before abandoning the hook.
  readonly timeout: number;
  // While the worktree's edits-unwatched marker exists the command exits
  // without starting node (buildSettingsJson).
  readonly skipWhileUnwatched?: true;
}

export type ClaudeHookDisposition =
  | { readonly register: readonly ClaudeHookRegistration[] }
  | { readonly unregistered: string };

export const CLAUDE_HOOK_EVENTS: Readonly<Record<string, ClaudeHookDisposition>> = {
  // Registered, in the order the settings file lists them.
  SessionStart: { register: [{ matcher: "", route: "sessionstart", timeout: 5 }] },
  UserPromptSubmit: { register: [{ matcher: "", route: "prompt", timeout: 5 }] },
  Stop: { register: [{ matcher: "", route: "stop", timeout: 5 }] },
  // A turn that dies on an API error (usage limit, expired login, dropped
  // connection) fires StopFailure instead of Stop. The turn is just as over,
  // so it takes the same route; without it the worker read `working` until
  // the operator typed into the pane.
  StopFailure: { register: [{ matcher: "", route: "stop", timeout: 5 }] },
  PreToolUse: {
    register: [
      // The two tools that wait on the operator. EnterPlanMode does not: it
      // fires mid-generation, and hooking it would flicker working/asking.
      { matcher: "AskUserQuestion", route: "pretooluse", timeout: 5 },
      { matcher: "ExitPlanMode", route: "pretooluse", timeout: 5 },
      // Records the worktree before a Bash call during review, so a
      // read-only command does not cancel it (hooks/default.ts).
      { matcher: "Bash", route: "toolstart", timeout: 10, skipWhileUnwatched: true },
    ],
  },
  // Fires only when a dialog is actually shown, for any tool.
  PermissionRequest: { register: [{ matcher: "", route: "pretooluse", timeout: 5 }] },
  // Catch-all: auto mode escalates any tool the classifier flags (Write, Edit,
  // Read, Bash, WebFetch, ...), not just Bash, so every tool completion has to
  // be seen to clear `asking` after the operator approves.
  PostToolUse: { register: [{ matcher: "", route: "posttooluse", timeout: 5 }] },
  // PostToolUse fires only for a tool that succeeded. A failed one (a Bash
  // edit chained to a failing `npm test`, an approved tool that errors) is the
  // same activity: it clears `asking`, and it can rewrite the tree a reviewer
  // is certifying.
  PostToolUseFailure: { register: [{ matcher: "", route: "posttooluse", timeout: 5 }] },

  // Unregistered, in Claude Code's own order.
  PostToolBatch: {
    unregistered: "PostToolUse and PostToolUseFailure already report each call in the batch, with the "
      + "per-call tool input and agent_id the handlers read; it would add a hook process per batch and no signal.",
  },
  Notification: {
    unregistered: "Fires for every notification type (idle prompts, auth results, finished agents and more), "
      + "not only the dialogs that wait on the operator, and never carries agent_id. PermissionRequest and the "
      + "AskUserQuestion and ExitPlanMode PreToolUse matchers report those dialogs (STATUS.md).",
  },
  UserPromptExpansion: {
    unregistered: "Reports how a typed slash command expanded into a prompt; no worker state follows from the "
      + "expansion.",
  },
  SessionEnd: {
    unregistered: "The launch wrapper's _agent-exited route records the agent's exit once the process is gone, "
      + "which also covers a kill that fires no SessionEnd; a session switched in place (/clear, /resume) is "
      + "reported by the SessionStart that follows.",
  },
  SubagentStart: {
    unregistered: "A subagent's start changes nothing garden shows: its tool events carry its agent_id and stamp "
      + "the delegating display (isDelegating), and the turn-end transcript scan finds a background agent "
      + "(background-tasks.ts).",
  },
  SubagentStop: {
    unregistered: "A subagent's result reaches the main thread as a tool result, or for a background agent as a "
      + "harness-submitted prompt that UserPromptSubmit reports and the next turn-end scan retires "
      + "(background-tasks.ts).",
  },
  PreCompact: {
    unregistered: "Compaction continues the session, so it moves no worker state, and garden has no compaction "
      + "instructions to add; the SessionStart with source compact is handled.",
  },
  PostCompact: {
    unregistered: "The SessionStart with source compact reports the same compaction, and onSessionStart keeps "
      + "the worker's status and background tasks across it.",
  },
  PreModelSwitch: {
    unregistered: "Lets a hook veto a model switch, which garden does not do; the watchdog reads the model each "
      + "worker runs and flags drift from its pin (model-drift.ts).",
  },
  PostModelSwitch: {
    unregistered: "The watchdog re-reads each worker's running model from its transcript every tick "
      + "(model-drift.ts), so a switch shows without a hook process.",
  },
  PermissionDenied: {
    unregistered: "Fires only when auto mode's classifier denies a call, which opens no dialog and leaves the turn "
      + "running, so there is no asking to clear; a dialog the operator denies fires no hook at all.",
  },
  Setup: {
    unregistered: "Fires only for Claude Code's repository init and maintenance runs (--init, --init-only, "
      + "--maintenance), which garden never launches.",
  },
  TeammateIdle: {
    unregistered: "Reports an agent-team teammate about to go idle; a worker's own turn end is Stop's to report, "
      + "and garden launches no agent teams.",
  },
  TaskCreated: {
    unregistered: "Reports an entry the agent adds to its task list, which garden neither reads nor gates.",
  },
  TaskCompleted: {
    unregistered: "Reports a task-list entry marked done; a worker's progress reaches garden as commits and turn "
      + "ends, not task-list entries.",
  },
  Elicitation: {
    unregistered: "Not handled yet: an MCP server's request for operator input holds the turn like a permission "
      + "dialog, but no hook raises asking for it, so the row reads working while it waits. Registering it needs "
      + "verifying against a server that elicits.",
  },
  ElicitationResult: {
    unregistered: "The answer to an Elicitation, which is unregistered, so there is no asking for it to clear.",
  },
  ConfigChange: {
    unregistered: "No worker state follows from a settings or skills change, and garden's own settings file "
      + "reaches Claude Code through --settings from the control tree, which no worker sandbox can write.",
  },
  WorktreeCreate: {
    unregistered: "Registering it replaces how Claude Code creates the worktrees it isolates work in: the hook "
      + "must print the new worktree's path, and one that prints none fails the creation. Garden creates each "
      + "worker's worktree itself, before launch.",
  },
  WorktreeRemove: {
    unregistered: "The removal half of WorktreeCreate, replacing how Claude Code removes a worktree it made; "
      + "garden removes each worker's worktree itself.",
  },
  InstructionsLoaded: {
    unregistered: "Observability only: names each CLAUDE.md or rule file that loads. Garden's rules reach the "
      + "worker as a system-prompt file (--append-system-prompt-file), which it does not report.",
  },
  CwdChanged: {
    unregistered: "For tools that set the shell's environment per directory (it receives CLAUDE_ENV_FILE); "
      + "garden sets a worker's environment once, at launch.",
  },
  FileChanged: {
    unregistered: "CwdChanged's companion, re-deriving the shell's environment when a watched file such as "
      + ".envrc changes; garden watches no file through the agent.",
  },
  DirectoryAdded: {
    unregistered: "Reports a directory added mid-session (/add-dir), after Claude Code has already refreshed the "
      + "sandbox for it; no worker state follows from it.",
  },
  MessageDisplay: {
    unregistered: "Fires as each completed line of a reply is displayed, so a hook can rewrite what is shown: a "
      + "hook process every few lines, for text garden reads from the transcript when it needs it (the ⌥h "
      + "history view).",
  },
};
