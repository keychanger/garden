// Low-level tmux helpers used throughout the dashboard.
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";

export function tmux(...args: string[]): void {
  execFileSync("tmux", args, { stdio: "ignore" });
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
  } catch { /* ignore */ }
}

export function setPaneTitle(paneId: string, title: string): void {
  try {
    tmux("select-pane", "-t", paneId, "-T", title);
  } catch { /* ignore */ }
}

export function setPaneLabel(paneId: string, label: string): void {
  try {
    tmux("set-option", "-p", "-t", paneId, "@garden_name", label);
  } catch { /* ignore */ }
}

export function setPaneVar(paneId: string, name: string, value: string): void {
  try {
    tmux("set-option", "-p", "-t", paneId, `@${name}`, value);
  } catch { /* ignore */ }
}

export function getPaneVar(paneId: string, name: string): string | null {
  try {
    const val = tmuxOutput("display-message", "-t", paneId, "-p", `#{@${name}}`);
    return val || null;
  } catch {
    return null;
  }
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

export function getPaneTitle(paneId: string): string | null {
  try {
    const raw = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_title}");
    if (!raw) return null;
    const cleaned = raw.replace(/^[^a-zA-Z0-9]+/, "").trim();
    return (cleaned && cleaned !== "Claude Code") ? cleaned : null;
  } catch {
    return null;
  }
}

export function getPaneLabel(paneId: string): string | null {
  try {
    const label = tmuxOutput("display-message", "-t", paneId, "-p", "#{@garden_name}");
    return label || null;
  } catch {
    return null;
  }
}

export function getClaudeChildPid(pid: string): string | null {
  try {
    return execFileSync("pgrep", ["-P", pid, "claude"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

export function hasClaudeChild(pid: string): boolean {
  return getClaudeChildPid(pid) !== null;
}

export function isClaudeWorking(shellPid: string): boolean {
  const claudePid = getClaudeChildPid(shellPid);
  if (!claudePid) return false;
  return hasChildProcesses(claudePid);
}

export function hasChildProcesses(pid: string): boolean {
  try {
    execFileSync("pgrep", ["-P", pid], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
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
  const prefix = `_${project}-worker-`;
  return names.filter(w => w.startsWith(prefix));
}

export function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
