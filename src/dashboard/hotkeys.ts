// Dashboard keybinding setup: maps Alt/Option keys to dashboard subcommands.
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, tmuxDoubleQuote } from "./tmux.js";

export function setupKeybindings(gardenRunner: string): void {
  // gardenRunner arrives pre-escaped from resolveGardenRunner() — each token
  // (interpreter + script) is individually shellEscape'd and joined by a
  // space, so the string interpolates safely into the bindMeta guarded-shell
  // commands below without re-wrapping (which would single-quote the whole
  // multi-token string and turn it into a non-existent filename).
  const gr = gardenRunner;

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

  // Navigation
  bindMeta("]", `${gr} dashboard _cycle-pane next`);
  bindMeta("[", `${gr} dashboard _cycle-pane prev`);
  bindMeta("s", `${gr} dashboard _focus-shell`);
  bindMeta("g", `${gr} dashboard _focus-growhouse`);
  bindMeta("r", `${gr} dashboard _focus-root`);
  bindMeta("l", `${gr} dashboard _focus-logs`);
  bindMeta("h", `${gr} dashboard _focus-history`);
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
