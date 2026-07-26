// Shared tmux display-menu primitive. crew-picker, trellis-picker, and the
// workflow picker each hand-rolled the same `["display-menu","-O","-T",title,
// "-x","C","-y","C", ...triples]` argv + execFileSync + catch/log block; the
// config/worker menus would make five copies. This centralizes it.
//
// A menu ROW is one of: a normal selectable item (label + quick-key + a
// command), or a separator (a horizontal rule). The command is either a raw
// tmux command (`tmux` — e.g. a `command-prompt`, already a tmux command) or a
// shell command (`run` — wrapped in `run-shell` via menuRunShell, since tmux
// parses a menu item's command as a TMUX command, not a shell one).
//
// Encoding notes (tmux 3.x): a separator is an empty-name item that consumes a
// SINGLE argv token — NOT a name/key/command triple. Disabled ("-"-prefixed)
// info rows are deliberately NOT supported: a leading "-" in a positional
// collides with tmux's own flag parser ("unknown flag -i"). Identity/status
// facts a menu wants to show go in the `title` instead.
import { execFileSync } from "node:child_process";
import { menuRunShell } from "./tmux.js";
import { log } from "./log.js";

export interface MenuRow {
  /** Visible label (ignored when `sep`). */
  label: string;
  /** Single-character quick-select key; omitted/"" for none. */
  key?: string;
  /** A shell command to run on select — wrapped in `run-shell` by runMenu. */
  run?: string;
  /** A raw tmux command to run on select (command-prompt rows, or a command
   *  already `run-shell`-wrapped). Takes precedence over `run`. */
  tmux?: string;
  /** Render a horizontal separator rule instead of a selectable item. */
  sep?: boolean;
}

export interface MenuSpec {
  title: string;
  rows: MenuRow[];
  /** Row to select when the menu opens (0-based, counting separators — tmux
   *  indexes every item and skips forward off an unselectable one). Omitted or
   *  negative leaves tmux's default, the first row. Menus re-opened by their
   *  own selection (the ⌥⇧N composer) use this so a choice returns the cursor
   *  where it was instead of the top. */
  startingChoice?: number;
}

// Build the `tmux display-menu` argv for a spec. Pure (menuRunShell is pure), so
// tests assert the argv without driving tmux. A separator pushes ONE token (the
// empty name); a normal row pushes three (label, key, command).
export function buildMenuArgv(spec: MenuSpec): string[] {
  const argv = ["display-menu", "-O", "-T", spec.title, "-x", "C", "-y", "C"];
  // tmux rejects a negative -C, and only honors it at all for a menu opened
  // from a key binding rather than the mouse — which is every menu garden opens.
  if (spec.startingChoice !== undefined && spec.startingChoice >= 0) {
    argv.push("-C", String(spec.startingChoice));
  }
  for (const row of spec.rows) {
    if (row.sep) {
      argv.push("");
      continue;
    }
    const command = row.tmux ?? (row.run ? menuRunShell(row.run) : "");
    argv.push(row.label, row.key ?? "", command);
  }
  return argv;
}

// Drive tmux display-menu for a spec. Fire-and-forget (the selected item's
// command dispatches its own process); a tmux failure is logged, not thrown, so
// a hotkey never surfaces a stack trace.
export function runMenu(spec: MenuSpec): void {
  try {
    execFileSync("tmux", buildMenuArgv(spec), { stdio: "ignore" });
  } catch (err) {
    log.warn("menu", "display-menu failed", { data: { error: String(err), title: spec.title } });
  }
}
