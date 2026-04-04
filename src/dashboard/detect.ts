// Consolidated worker process status detection.
// Single source of truth for "what is this worker's process status?"
// Combines pgrep-based child process detection with hook-based marker files.
import {
  getPanePid, getClaudeChildPid, hasChildProcesses, hasNonMcpChildren,
  getPaneVar, getPaneTitle,
} from "./tmux.js";
import { isClaudeActiveByHook, touchClaudeActiveMarker } from "./header.js";

export type ProcessStatus = "loading" | "ready" | "working" | "idle" | "exited";

export interface PaneProcessInfo {
  status: ProcessStatus;
  activity: string | null;
}

export function detectPaneProcessStatus(
  paneId: string,
  project?: string,
  worker?: string,
): PaneProcessInfo {
  const pid = getPanePid(paneId);
  if (!pid) return { status: "exited", activity: null };

  const claudePid = getClaudeChildPid(pid);
  if (!claudePid) {
    if (hasChildProcesses(pid)) return { status: "loading", activity: null };
    return { status: "ready", activity: null };
  }

  const activity = getPaneVar(paneId, "garden_task") ?? getPaneTitle(paneId) ?? null;
  // Check for active tool children, excluding persistent MCP servers.
  // MCP servers are long-running child processes that don't indicate work.
  if (!hasNonMcpChildren(claudePid)) {
    // No active tool processes. Claude may still be working in-process
    // (subagents making API calls). Check hook-based active state marker.
    if (project && worker && isClaudeActiveByHook(project, worker)) {
      return { status: "working", activity };
    }
    return { status: activity ? "idle" : "ready", activity };
  }
  // Touch the marker to keep its mtime fresh while tools are running.
  // This way the staleness timeout measures "time since last tool activity"
  // rather than "time since UserPromptSubmit," catching stuck markers faster.
  if (project && worker) touchClaudeActiveMarker(project, worker);
  return { status: "working", activity };
}

export function isWorkerWorking(
  paneId: string,
  project: string,
  worker: string,
): boolean {
  const info = detectPaneProcessStatus(paneId, project, worker);
  return info.status === "working";
}
