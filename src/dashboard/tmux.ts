// Low-level tmux helpers used throughout the dashboard.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { DASHBOARD_SESSION } from "../session.js";
import { log } from "./log.js";
import { workerWindowPrefix } from "./window-names.js";

export function tmux(...args: string[]): void {
  execFileSync("tmux", args, { stdio: "ignore" });
}

// Paste a message into a Claude pane and submit it. The 300ms gap between
// the paste and `Enter` matters on cold-start panes (`claude --resume` after
// a dashboard restart, fresh sessions for handoff/seed): claude's TUI
// finishes binding its input handler / settles paste-detection during this
// window, so the Enter actually triggers submit instead of being absorbed
// into the paste burst.
//
// Delivery routes through a tmux buffer (load-buffer reads from stdin,
// paste-buffer floods the bytes into the pane) instead of `send-keys -l`.
// The send-keys path put the entire message in argv; ~14KB handoff briefings
// were silently failing with E2BIG / tmux command-buffer overflow, leaving
// the new worker parked at status:ready with a never-delivered seed. Buffers
// are byte streams with no argv exposure, so multi-MB seeds work uniformly.
let pasteBufferCounter = 0;
export function pasteAndSubmit(paneId: string, message: string): void {
  const bufferName = `garden-paste-${process.pid}-${++pasteBufferCounter}`;
  try {
    execFileSync("tmux", ["load-buffer", "-b", bufferName, "-"], {
      input: message,
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new Error(`tmux load-buffer failed${stderr ? `: ${stderr}` : ""}`);
  }
  try {
    execFileSync("tmux", ["paste-buffer", "-d", "-b", bufferName, "-t", paneId], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    try {
      execFileSync("tmux", ["delete-buffer", "-b", bufferName], { stdio: "ignore" });
    } catch { /* buffer may already be gone */ }
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new Error(`tmux paste-buffer failed${stderr ? `: ${stderr}` : ""}`);
  }
  execFileSync("sleep", ["0.3"], { stdio: "ignore" });
  execFileSync("tmux", ["send-keys", "-t", paneId, "Enter"], { stdio: "ignore" });
}

export function tmuxOutput(...args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function tmuxSplit(...args: string[]): string {
  return execFileSync("tmux", ["split-window", "-P", "-F", "#{pane_id}", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function tmuxNewWindow(...args: string[]): string {
  return execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function getActivePaneId(): string | null {
  try {
    return tmuxOutput("display-message", "-t", DASHBOARD_SESSION, "-p", "#{pane_id}");
  } catch {
    return null;
  }
}

export function tmuxDisplay(msg: string): void {
  try {
    tmux("display-message", "-t", DASHBOARD_SESSION, msg);
  } catch { log.debug("tmux", "tmuxDisplay failed"); }
}

export function setPaneTitle(paneId: string, title: string): void {
  try {
    tmux("select-pane", "-t", paneId, "-T", title);
  } catch { log.debug("tmux", "setPaneTitle failed", { data: { paneId } }); }
}

export function setPaneLabel(paneId: string, label: string): void {
  try {
    tmux("set-option", "-p", "-t", paneId, "@garden_name", label);
  } catch { log.debug("tmux", "setPaneLabel failed", { data: { paneId } }); }
}

export function setPaneVar(paneId: string, name: string, value: string): void {
  try {
    tmux("set-option", "-p", "-t", paneId, `@${name}`, value);
  } catch { log.debug("tmux", "setPaneVar failed", { data: { paneId, name } }); }
}

export function getFirstPaneId(target: string): string | null {
  try {
    return tmuxOutput("list-panes", "-t", target, "-F", "#{pane_id}").split("\n")[0] || null;
  } catch {
    return null;
  }
}

export function paneExists(paneId: string): boolean {
  try {
    const result = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_id}");
    return result === paneId;
  } catch {
    return false;
  }
}

export function windowExists(windowName: string): boolean {
  try {
    tmuxOutput("list-panes", "-t", `${DASHBOARD_SESSION}:${windowName}`, "-F", "#{pane_id}");
    return true;
  } catch {
    return false;
  }
}

export function renameWindow(oldName: string, newName: string): void {
  try {
    tmux("rename-window", "-t", `${DASHBOARD_SESSION}:${oldName}`, newName);
  } catch { log.debug("tmux", "renameWindow failed", { data: { oldName, newName } }); }
}

export function getPaneSize(paneId: string): { width: number; height: number } | null {
  try {
    const out = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_width} #{pane_height}");
    const parts = out.split(" ");
    if (parts.length !== 2) return null;
    return { width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) };
  } catch {
    return null;
  }
}

export function resizeWindow(windowName: string, width: number, height: number): void {
  try {
    tmux("resize-window", "-t", `${DASHBOARD_SESSION}:${windowName}`, "-x", String(width), "-y", String(height));
  } catch { /* ignore — window may not exist */ }
}

export function killWindowSafe(windowName: string): void {
  try {
    tmux("kill-window", "-t", `${DASHBOARD_SESSION}:${windowName}`);
  } catch { /* ignore */ }
}

export function getPanePid(paneId: string): string | null {
  try {
    return tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_pid}");
  } catch {
    return null;
  }
}

// `select-pane -d` blocks tmux from forwarding keystrokes to the pane's pty —
// the chars never reach the terminal driver, so no echo, no buffering. Used on
// the status/usage panes which run a passive sleep loop with nothing to read
// stdin. Survives swap-pane (input-disabled is a pane-level flag) but not
// respawn-pane, so callers must re-apply after each respawn.
export function disablePaneInput(paneId: string): void {
  try {
    tmux("select-pane", "-d", "-t", paneId);
  } catch { log.debug("tmux", "disablePaneInput failed", { data: { paneId } }); }
}

export function getPaneLabel(paneId: string): string | null {
  try {
    const label = tmuxOutput("display-message", "-t", paneId, "-p", "#{@garden_name}");
    return label || null;
  } catch {
    return null;
  }
}

// Read the tmux pane title. Claude Code sets this via terminal escape
// sequences (OSC 0/2) as it works, so it doubles as a "what is this worker
// currently doing" summary. We strip the leading non-alphanumeric noise
// (Claude prefixes with characters like "✱ ") and reject the default
// "Claude Code" placeholder and system hostname (tmux defaults new panes
// to the hostname, which would overwrite the persisted task on resume).
export function getPaneTitle(paneId: string): string | null {
  try {
    const raw = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_title}");
    if (!raw) return null;
    const cleaned = raw.replace(/^[^a-zA-Z0-9]+/, "").trim();
    if (!cleaned || cleaned === "Claude Code") return null;
    if (cleaned === os.hostname()) return null;
    return cleaned;
  } catch {
    return null;
  }
}

export function listAllWindowNames(): string[] {
  try {
    return tmuxOutput(
      "list-windows", "-t", DASHBOARD_SESSION, "-F", "#{window_name}"
    ).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function listHiddenWorkerWindows(project: string, windowNames?: string[]): string[] {
  const names = windowNames ?? listAllWindowNames();
  const prefix = workerWindowPrefix(project);
  return names.filter(w => w.startsWith(prefix));
}

// Returns a fully single-quoted bash literal of the input. Safe for all
// shell metacharacters. Strings that match the safe-token character class
// are passed through unquoted as a tiny readability optimization. Use the
// result WITHOUT additional surrounding `'...'` in templates — the helper
// already supplies the outer quotes when needed. Prefer this over inline
// `.replace(/'/g, "'\\''")` so all bash escaping flows through one helper.
export function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Tmux's own command parser supports double-quoted strings: $variable
// expansion and command substitution are interpreted inside them, and
// backslash escapes the next character. When passing a shell command
// through tmux's run-shell or set-hook command-templates, the outer wrapper
// is a tmux-parsed string — wrap with this helper so $, `, \, " in the
// shell command don't get re-interpreted by tmux before reaching the shell.
// `#` is NOT escaped — tmux format references like #{window_name} remain
// active inside the wrapped string.
export function tmuxDoubleQuote(s: string): string {
  return `"${s.replace(/[\\$"`]/g, "\\$&")}"`;
}
