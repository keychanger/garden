// Dashboard keybinding setup: maps Alt/Option keys to dashboard subcommands.
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxDoubleQuote } from "./tmux.js";

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

  // Project switching: ⌥1 through ⌥9
  for (let i = 1; i <= 9; i++) {
    bindMeta(String(i), `${gr} dashboard _switch ${i}`);
  }

  // Worker management
  bindMeta("n", `${gr} dashboard _new-worker`);
  bindMeta("N", `${gr} dashboard _workflow-picker`);
  bindMeta("w", `${gr} dashboard _focus-worker`);
  bindMeta("x", `${gr} dashboard _kill-pane`);
  bindMeta("b", `${gr} dashboard _bounce`);
  // ⌥e — the tracked Escape: interrupt the focused worker's turn and mark it
  // `paused` (toggles back to idle when already held). Garden cannot observe a
  // raw Escape (no Claude Code hook fires on interrupt), so this is how a
  // deliberate hold becomes visible in the dashboard.
  bindMeta("e", `${gr} dashboard _hold-worker`);

  // Navigation
  bindMeta("]", `${gr} dashboard _cycle-pane next`);
  bindMeta("[", `${gr} dashboard _cycle-pane prev`);
  bindMeta("s", `${gr} dashboard _focus-shell`);
  bindMeta("g", `${gr} dashboard _focus-growhouse`);
  bindMeta("r", `${gr} dashboard _focus-root`);
  bindMeta("l", `${gr} dashboard _focus-logs`);
  bindMeta("h", `${gr} dashboard _focus-history`);
  bindMeta("d", `${gr} dashboard _focus-diary`);
  bindMeta("/", `${gr} dashboard _logs-filter`);
  bindMeta(".", `${gr} dashboard _logs-filter-apply`);
  bindMeta("p", `${gr} dashboard _cycle-plot next`);
  bindMeta("P", `${gr} dashboard _cycle-plot prev`);
  bindMeta("o", `${gr} dashboard _cycle-plot prev`);
  bindMeta("k", "tmux clear-history; tmux send-keys -R C-l");

  // Mouse scroll: always enter copy-mode on wheel-up instead of passing
  // events to alternate-screen apps (like Claude Code).
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "WheelUpPane",
      "if-shell", "-F", "#{pane_in_mode}",
      "send-keys -M",
      "copy-mode -e; send-keys -M"
    ], { stdio: "ignore" });
  } catch { /* ignore */ }
  try {
    execFileSync("tmux", [
      "bind-key", "-n", "WheelDownPane",
      "send-keys", "-M"
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
  const argv: string[][] = [
    ["unbind-key", "-n", `M-${key}`],
    ["unbind-key", "-T", "copy-mode", `M-${key}`],
    ["unbind-key", "-T", "copy-mode-vi", `M-${key}`],
  ];
  for (const args of argv) {
    try { execFileSync("tmux", args, { stdio: "ignore" }); } catch { /* not bound */ }
  }
}

function bindMeta(key: string, command: string): void {
  const guarded = `if [ "$(tmux display-message -p '##{session_name}')" = "${DASHBOARD_SESSION}" ]; then ${command} >/dev/null 2>&1; fi`;
  try {
    execFileSync("tmux", [
      "bind-key", "-n", `M-${key}`, "run-shell", guarded
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
  const body = `send-keys -X cancel ; run-shell ${tmuxDoubleQuote(guarded)}`;
  for (const table of ["copy-mode", "copy-mode-vi"]) {
    try {
      execFileSync("tmux", [
        "bind-key", "-T", table, `M-${key}`, body
      ], { stdio: "ignore" });
    } catch { /* ignore */ }
  }
}
