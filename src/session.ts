// Manages tmux sessions and per-session state files for garden projects.
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config.js";

export interface SessionState {
  mode: "paused" | "auto";
  currentTaskId: string | null;
  lastTaskId: string | null;
  startedAt: string;
  completedTasks: number;
  pid: number | null;
}

function statePath(name: string): string {
  return path.join(SESSIONS_DIR, `${name}.state`);
}

export function tmuxSessionName(name: string): string {
  return `garden-${name}`;
}

export function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", tmuxSessionName(name)], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function listTmuxSessions(): string[] {
  try {
    const output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .trim()
      .split("\n")
      .filter((s) => s.startsWith("garden-"))
      .map((s) => s.replace("garden-", ""));
  } catch {
    return [];
  }
}

export function createTmuxSession(
  name: string,
  command: string,
  cwd: string
): void {
  execFileSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      tmuxSessionName(name),
      "-c",
      cwd,
      command,
    ],
    { stdio: "ignore" }
  );
}

export function killTmuxSession(name: string): void {
  execFileSync("tmux", ["kill-session", "-t", tmuxSessionName(name)], {
    stdio: "ignore",
  });
}

export function attachTmuxSession(name: string): void {
  execSync(`tmux attach -t ${tmuxSessionName(name)}`, {
    stdio: "inherit",
  });
}

export function readState(name: string): SessionState | null {
  const p = statePath(name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function writeState(name: string, state: SessionState): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(statePath(name), JSON.stringify(state, null, 2));
}

export function clearState(name: string): void {
  const p = statePath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function sendSignal(name: string): void {
  const state = readState(name);
  if (!state?.pid) {
    throw new Error(`No worker PID found for ${name}`);
  }
  process.kill(state.pid, "SIGUSR1");
}

export function checkTmux(): void {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "tmux is not installed. Install it with: brew install tmux"
    );
  }
}

// --- Dashboard helpers ---

export const DASHBOARD_SESSION = "garden-dashboard";

export function dashboardExists(): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", DASHBOARD_SESSION], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function createDashboardSession(command: string, cwd: string): void {
  execFileSync(
    "tmux",
    ["new-session", "-d", "-s", DASHBOARD_SESSION, "-n", "status", "-c", cwd, "sh", "-c", command],
    { stdio: "ignore" }
  );
}

export function attachDashboardSession(): void {
  execSync(`tmux attach -t ${DASHBOARD_SESSION}`, { stdio: "inherit" });
}

export function killDashboardSession(): void {
  execFileSync("tmux", ["kill-session", "-t", DASHBOARD_SESSION], {
    stdio: "ignore",
  });
}

export function createTmuxWindow(
  session: string,
  windowName: string,
  cwd: string,
  command?: string
): void {
  const args = ["new-window", "-t", session, "-n", windowName, "-c", cwd];
  if (command) args.push(command);
  execFileSync("tmux", args, { stdio: "ignore" });
}

export function listTmuxWindows(session: string): string[] {
  try {
    const output = execFileSync(
      "tmux",
      ["list-windows", "-t", session, "-F", "#{window_name}"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function selectTmuxWindow(session: string, windowName: string): void {
  execFileSync("tmux", ["select-window", "-t", `${session}:${windowName}`], {
    stdio: "ignore",
  });
}

export function splitTmuxPane(
  session: string,
  vertical: boolean,
  cwd: string,
  percent?: number
): void {
  const args = [
    "split-window",
    vertical ? "-v" : "-h",
    "-t", session,
    "-c", cwd,
  ];
  if (percent) args.push("-p", String(percent));
  execFileSync("tmux", args, { stdio: "ignore" });
}

export function countTmuxPanes(target: string): number {
  try {
    const output = execFileSync(
      "tmux",
      ["list-panes", "-t", target, "-F", "#{pane_id}"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return output.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function splitTmuxPaneWithCommand(
  target: string,
  cwd: string,
  command?: string
): void {
  // Split the last pane in the target window
  const args = ["split-window", "-t", target, "-c", cwd];
  if (command) args.push(command);
  execFileSync("tmux", args, { stdio: "ignore" });
}

export function tileLayout(target: string): void {
  execFileSync("tmux", ["select-layout", "-t", target, "tiled"], {
    stdio: "ignore",
  });
}

export function setTmuxBinding(
  session: string,
  key: string,
  command: string
): void {
  execFileSync("tmux", ["bind-key", "-T", "prefix", key, "run-shell", command], {
    stdio: "ignore",
  });
}
