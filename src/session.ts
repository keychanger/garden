// Manages tmux sessions and per-session state files for garden projects.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config.js";

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
  const session = tmuxSessionName(name);
  execFileSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      session,
      "-n",
      name,
      "-c",
      cwd,
      command,
    ],
    { stdio: "ignore" }
  );
  execFileSync("tmux", ["set-option", "-t", session, "mouse", "on"], {
    stdio: "ignore",
  });
}

export function killTmuxSession(name: string): void {
  execFileSync("tmux", ["kill-session", "-t", tmuxSessionName(name)], {
    stdio: "ignore",
  });
}

export function attachTmuxSession(name: string): void {
  execFileSync("tmux", ["attach", "-t", tmuxSessionName(name)], {
    stdio: "inherit",
  });
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
  if (process.env.TMUX) {
    // Already inside tmux — try switch-client, fall back to attach if no active client
    try {
      execFileSync("tmux", ["switch-client", "-t", DASHBOARD_SESSION], { stdio: "inherit" });
      return;
    } catch {
      // TMUX env var is stale (session died) — fall through to attach
    }
  }
  execFileSync("tmux", ["attach", "-t", DASHBOARD_SESSION], { stdio: "inherit" });
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
