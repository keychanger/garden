// Dashboard keybinding setup: maps Alt/Option keys to dashboard subcommands.
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux } from "./tmux.js";

export function setupKeybindings(gardenRunner: string): void {
  const gr = gardenRunner;

  // Project switching: ⌥1 through ⌥9
  for (let i = 1; i <= 9; i++) {
    bindMeta(String(i), `${gr} dashboard _switch ${i}`);
  }

  // Worker management
  bindMeta("n", `${gr} dashboard _new-worker`);
  bindMeta("w", `${gr} dashboard _focus-worker`);
  bindMeta("x", `${gr} dashboard _kill-pane`);

  // Navigation
  bindMeta("]", `${gr} dashboard _cycle-pane next`);
  bindMeta("[", `${gr} dashboard _cycle-pane prev`);
  bindMeta("s", `${gr} dashboard _focus-shell`);
  bindMeta("g", `${gr} dashboard _focus-garden`);
  bindMeta("k", "tmux clear-history; tmux send-keys -R C-l");

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
}
