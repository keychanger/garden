// Single source of truth for garden's Meta-key dashboard hotkeys. hotkeys.ts
// binds these into tmux; keys.ts (`garden keys`) documents them. Deriving both
// from this one table is what keeps the bound set and the documented set from
// drifting — the failure mode where a new binding (⌥e, ⌥h, ⌥/, ⌥.) shipped in
// hotkeys.ts but never reached `garden keys`.
//
// ⌥1–⌥9 (switch to project by number) is a generated range, and the tmux-default
// prefix keys (ctrl-b d / z) are not garden bindings — both are documented as
// fixed lines in keys.ts and handled directly in hotkeys.ts, so they are not in
// this table.
export type KeyCategory = "Navigation" | "Projects" | "Workers" | "General";

export interface DashboardHotkey {
  // The key pressed with Meta/Option, as tmux names it (e.g. "n", "]", "/",
  // "N"). Uppercase letters are shifted (⌥⇧N).
  key: string;
  // When `raw` is false (default): the `garden dashboard <command>` argument
  // string the binding runs (e.g. "_cycle-pane next"). When `raw` is true:
  // a literal tmux/shell command bound as-is.
  command: string;
  raw?: boolean;
  category: KeyCategory;
  // Human description shown by `garden keys`.
  label: string;
}

export const DASHBOARD_HOTKEYS: DashboardHotkey[] = [
  // Navigation
  { key: "g", command: "_focus-growhouse", category: "Navigation", label: "Focus growhouse (garden> prompt)" },
  { key: "r", command: "_focus-root", category: "Navigation", label: "Focus root shell" },
  { key: "l", command: "_focus-logs", category: "Navigation", label: "Focus logs" },
  { key: "h", command: "_focus-history", category: "Navigation", label: "Focus history (focused worker's prompt history)" },
  { key: "d", command: "_focus-diary", category: "Navigation", label: "Focus diary (focused project's diary in $EDITOR)" },
  { key: "w", command: "_focus-worker", category: "Navigation", label: "Jump to first worker" },
  { key: "s", command: "_focus-shell", category: "Navigation", label: "Jump to project shell" },
  { key: "]", command: "_cycle-pane next", category: "Navigation", label: "Cycle to next worker (right pane)" },
  { key: "[", command: "_cycle-pane prev", category: "Navigation", label: "Cycle to previous worker (right pane)" },
  { key: "/", command: "_logs-filter", category: "Navigation", label: "Edit the logs sticky filter" },
  { key: ".", command: "_logs-filter-apply", category: "Navigation", label: "Clear the logs sticky filter" },

  // Projects
  { key: "p", command: "_cycle-plot next", category: "Projects", label: "Cycle to next focused plot" },
  { key: "P", command: "_cycle-plot prev", category: "Projects", label: "Cycle to previous focused plot" },
  { key: "o", command: "_cycle-plot prev", category: "Projects", label: "Cycle to previous focused plot (alias of ⌥⇧P)" },

  // Workers
  { key: "n", command: "_new-worker", category: "Workers", label: "New worker (Claude session)" },
  { key: "N", command: "_workflow-picker", category: "Workers", label: "Workflow picker (default / trellis / grow)" },
  { key: "e", command: "_hold-worker", category: "Workers", label: "Hold/resume the focused worker (tracked interrupt → paused)" },
  { key: "x", command: "_kill-pane", category: "Workers", label: "Kill current worker (shell protected)" },
  { key: "b", command: "_bounce", category: "Workers", label: "Bounce current worker (restart Claude, preserve history)" },

  // General
  { key: "k", command: "tmux clear-history; tmux send-keys -R C-l", raw: true, category: "General", label: "Refresh/redraw screen" },
];

// The ⌥-prefixed display form of a hotkey, with ⇧ for shifted (uppercase) keys.
export function hotkeyDisplay(key: string): string {
  const shifted = key.length === 1 && key >= "A" && key <= "Z";
  return shifted ? `⌥⇧${key}` : `⌥${key}`;
}
