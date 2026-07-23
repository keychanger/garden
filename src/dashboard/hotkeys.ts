// Dashboard keybinding setup: maps Alt/Option keys to dashboard subcommands.
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxDoubleQuote } from "./tmux.js";
import { DASHBOARD_HOTKEYS } from "./keybindings.js";

// Alt keys garden used to bind and no longer does. tmux key bindings are
// server-global and survive a key being repurposed, so a plain reattach won't
// drop them — the stale binding lingers and fires a now-removed command (exit
// 1). Actively unbinding them on every setup self-heals without a
// `tmux kill-server`. ⌥c was the old conversation/history binding (renamed to
// ⌥h); unbinding lets it pass through to the operator, who reclaimed it.
const RETIRED_META_KEYS = ["c"];

export function setupKeybindings(gardenRunner: string): void {
  // gardenRunner arrives pre-escaped from resolveGardenRunner() — each token
  // (interpreter + script) is individually shellEscape'd and joined by a
  // space, so the string interpolates safely into the bindMeta guarded-shell
  // commands below without re-wrapping (which would single-quote the whole
  // multi-token string and turn it into a non-existent filename).
  const gr = gardenRunner;

  // Drop retired bindings before (re)installing the current set.
  for (const key of RETIRED_META_KEYS) unbindMeta(key);

  // Project switching: ⌥1 through ⌥9 (a generated range — documented in
  // keys.ts as one line, so kept out of the shared DASHBOARD_HOTKEYS table).
  for (let i = 1; i <= 9; i++) {
    bindMeta(String(i), `${gr} dashboard _switch ${i}`);
  }

  // Every other Meta-key binding derives from the shared table so `garden keys`
  // documents exactly what is bound here (see keybindings.ts).
  for (const b of DASHBOARD_HOTKEYS) {
    bindMeta(b.key, b.raw ? b.command : `${gr} dashboard ${b.command}`);
  }

  // Mouse scroll: always enter copy-mode on wheel-up instead of passing
  // events to alternate-screen apps (like Claude Code). Gated on
  // @garden_mouse_lock (set only on the usage/status panes — see
  // lockPaneMouse in tmux.ts): on those two, the wheel is a no-op rather
  // than scrolling, since they're pure repaint content with nothing to
  // scroll back through.
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "WheelUpPane",
      "if-shell", "-F", "-t", "=", "#{@garden_mouse_lock}",
      "select-pane -t =",
      'if-shell -F "#{pane_in_mode}" "send-keys -M" "copy-mode -e; send-keys -M"'
    ], { stdio: "ignore" });
  } catch { /* ignore */ }
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "WheelDownPane",
      "if-shell", "-F", "-t", "=", "#{@garden_mouse_lock}",
      "select-pane -t =",
      "send-keys -M"
    ], { stdio: "ignore" });
  } catch { /* ignore */ }

  // Mouse click/drag/double/triple-click: same @garden_mouse_lock gate as the
  // wheel bindings above, so the usage/status panes can't be text-selected
  // either. The false branch reproduces tmux's own stock root-table bindings
  // for these events (see `tmux list-keys -T root`) so every other pane's
  // click/drag/select-word/select-line behavior is unchanged.
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "MouseDown1Pane",
      "if-shell", "-F", "-t", "=", "#{@garden_mouse_lock}",
      "select-pane -t =",
      "select-pane -t = ; send-keys -M"
    ], { stdio: "ignore" });
  } catch { /* ignore */ }
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "MouseDrag1Pane",
      "if-shell", "-F", "-t", "=", "#{@garden_mouse_lock}",
      "select-pane -t =",
      'if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'
    ], { stdio: "ignore" });
  } catch { /* ignore */ }
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "DoubleClick1Pane",
      "if-shell", "-F", "-t", "=", "#{@garden_mouse_lock}",
      "select-pane -t =",
      'select-pane -t = ; if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -H ; send-keys -X select-word ; run-shell -d 0.3 ; send-keys -X copy-pipe-and-cancel"'
    ], { stdio: "ignore" });
  } catch { /* ignore */ }
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "TripleClick1Pane",
      "if-shell", "-F", "-t", "=", "#{@garden_mouse_lock}",
      "select-pane -t =",
      'select-pane -t = ; if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -H ; send-keys -X select-line ; run-shell -d 0.3 ; send-keys -X copy-pipe-and-cancel"'
    ], { stdio: "ignore" });
  } catch { /* ignore */ }

  // Mouse selection in copy-mode. tmux's default selection-ending bindings
  // (MouseDragEnd / Double / TripleClick) all finish with copy-pipe-and-cancel,
  // which cancels copy-mode on mouse release. Cancelling snaps a scrolled-up
  // pane back to the live (bottom) screen, so the operator loses their scroll
  // position the instant they finish highlighting text. copy-pipe-no-clear still
  // copies (and pipes to the clipboard) but keeps copy-mode active at the
  // current offset, leaving the selection highlighted.
  //
  // Because the highlight now lingers, MouseDown1Pane (a plain click) also
  // clears the selection — clicking elsewhere dismisses the highlight, matching
  // native terminal selection. Mouse-down fires before MouseDrag1Pane's
  // begin-selection, so starting a fresh drag still works (the click clears the
  // stale selection, then the drag begins a new one).
  //
  // Each body is a single argv string: a bare ";" argv is a top-level command
  // separator, not part of the bound command (see bindMeta's copy-mode body for
  // the same constraint).
  const copyModeMouseBindings: Record<string, string> = {
    MouseDown1Pane: "select-pane ; send-keys -X clear-selection",
    MouseDragEnd1Pane: "send-keys -X copy-pipe-no-clear",
    DoubleClick1Pane: "select-pane ; send-keys -X select-word ; run-shell -d 0.3 ; send-keys -X copy-pipe-no-clear",
    TripleClick1Pane: "select-pane ; send-keys -X select-line ; run-shell -d 0.3 ; send-keys -X copy-pipe-no-clear",
  };
  for (const table of ["copy-mode", "copy-mode-vi"]) {
    for (const [event, body] of Object.entries(copyModeMouseBindings)) {
      try {
        execFileSync("tmux", ["bind-key", "-T", table, event, body], { stdio: "ignore" });
      } catch { /* ignore */ }
    }
  }

  // Lock window navigation to main so prefix+n/p can't escape to hidden windows
  try {
    const mainTarget = `${DASHBOARD_SESSION}:main`;
    tmux("bind-key", "-T", "prefix", "n", "select-window", "-t", mainTarget);
    tmux("bind-key", "-T", "prefix", "p", "select-window", "-t", mainTarget);
    tmux("bind-key", "-T", "prefix", "l", "select-window", "-t", mainTarget);
    for (let i = 0; i <= 9; i++) {
      tmux("bind-key", "-T", "prefix", String(i), "select-window", "-t", mainTarget);
    }
  } catch { /* ignore */ }
}

// Remove a M-<key> binding from the root table and both copy-mode tables (the
// three tables bindMeta installs into). Each unbind is best-effort: tmux errors
// when the key isn't bound, which is fine.
function unbindMeta(key: string): void {
  const metaKey = `M-${tmuxKeyName(key)}`;
  const argv: string[][] = [
    ["unbind-key", "-n", metaKey],
    ["unbind-key", "-T", "copy-mode", metaKey],
    ["unbind-key", "-T", "copy-mode-vi", metaKey],
  ];
  for (const args of argv) {
    try { execFileSync("tmux", args, { stdio: "ignore" }); } catch { /* not bound */ }
  }
}

// tmux's key-name parser treats a bare `;` as the command separator, so a
// `M-;` bind target is rejected with "unknown key: M-". The key name must be
// escaped as `M-\;`. This is a binding-layer quirk only — the shared table
// keeps the clean semantic key `;` so `garden keys` / hotkeyDisplay render it
// as ⌥; (comma is not special and needs no escape, so it's the sole case).
export function tmuxKeyName(key: string): string {
  return key === ";" ? "\\;" : key;
}

function bindMeta(key: string, command: string): void {
  const metaKey = `M-${tmuxKeyName(key)}`;
  const guarded = `if [ "$(tmux display-message -p '##{session_name}')" = "${DASHBOARD_SESSION}" ]; then ${command} >/dev/null 2>&1; fi`;
  // `-b` runs the handler in the background so it does NOT block tmux's command
  // queue: without it, run-shell holds the queue until the handler process
  // exits (node cold start + the full repaint cascade), so a burst of nav
  // keystrokes serialized one-behind-another and latency visibly accumulated.
  // Handlers still serialize their state mutation via withStateLock; only the
  // tmux-queue block is removed.
  try {
    execFileSync("tmux", [
      "bind-key", "-n", metaKey, "run-shell", "-b", guarded
    ], { stdio: "ignore" });
  } catch { /* ignore */ }

  // Root-table bindings (-n) are bypassed when a pane is in copy-mode (e.g.
  // a worker pane scrolled up via WheelUpPane). Without an explicit binding
  // in the copy-mode tables, M-<digit> in a scrolled-up pane is consumed by
  // copy-mode's numeric-prefix handler and renders in the tmux status line
  // instead of firing the dashboard hotkey. Cancel copy-mode first so the
  // active pane is back on its live screen before the command runs.
  //
  // The chained body MUST be a single argv. Passing ";" as its own argv to
  // bind-key makes tmux treat it as a top-level command separator: bind-key
  // gets only `send-keys -X cancel` and the `run-shell <guarded>` fires
  // immediately at setup time — once per key per table, dispatching every
  // dashboard hotkey command (including _trellis-picker) every time
  // setupKeybindings runs (e.g., after each garden post-merge rebuild).
  const body = `send-keys -X cancel ; run-shell -b ${tmuxDoubleQuote(guarded)}`;
  for (const table of ["copy-mode", "copy-mode-vi"]) {
    try {
      execFileSync("tmux", [
        "bind-key", "-T", table, metaKey, body
      ], { stdio: "ignore" });
    } catch { /* ignore */ }
  }
}
