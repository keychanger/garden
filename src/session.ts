import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config.js";

export interface SessionState {
  mode: "paused" | "auto";
  currentTaskId: string | null;
  startedAt: string;
  completedTasks: number;
  pid: number | null;
}

function statePath(name: string): string {
  return path.join(SESSIONS_DIR, `${name}.state`);
}

function logPath(name: string): string {
  return path.join(SESSIONS_DIR, `${name}.log`);
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

export function readLog(name: string): string {
  const p = logPath(name);
  if (!fs.existsSync(p)) return "(no log output)";
  return fs.readFileSync(p, "utf-8");
}

export function clearLog(name: string): void {
  const p = logPath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function getLogPath(name: string): string {
  return logPath(name);
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
