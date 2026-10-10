// Background tasks a Claude Code worker left running when its turn ended.
//
// A worker that starts a long command with `run_in_background` (or an async
// Agent) and ends its turn is still on the task: the harness holds the process
// and starts a new turn on its own when it finishes. No hook fires for any of
// that, so without this the row reads `idle` for the whole wait. The Stop hook
// scans what its transcript appended since the last scan and keeps the set of
// launched-but-unfinished task ids; isDelegating (registry.ts) renders a
// non-empty set as `working bg`.
//
// The transcript is the only record of the lifecycle, and its shapes were read
// off Claude Code 2.1.286:
//   launch:  a user record whose toolUseResult carries `backgroundTaskId`
//            (Bash), `isAsync: true` + `agentId` (Agent), or `taskId` +
//            `timeoutMs` (Monitor; a `persistent` one watches for the life of
//            the session and never finishes, so it is not a wait)
//   finish:  a `<task-notification>` naming the `<task-id>` with a `<status>`
//            (completed / failed / killed); a Monitor's per-event
//            notifications carry no status, only its "stream ended" one does
//   stop:    a TaskStop (or legacy KillShell) tool call — it emits no
//            notification, so a stopped task would otherwise stay pending
//
// Hook-bundle leaf: node:fs only.
import fs from "node:fs";

export interface BackgroundTaskScan {
  transcriptPath: string;
  // Byte offset of the first line not yet scanned.
  offset: number;
  pending: string[];
}

// How far back a worker with no prior scan looks. Bounds the first Stop after
// an upgrade on a long transcript; a launch older than this is simply missed,
// which is the behavior before this existed.
const FIRST_SCAN_BYTES = 4 * 1024 * 1024;

const MARKERS = ["backgroundTaskId", "async_launched", "timeoutMs", "<task-notification>", "TaskStop", "KillShell"];

// A fresh process holds no background tasks, so every launch already in the
// transcript is dead. Starting the scan at its end keeps a resumed session from
// reviving them.
export function backgroundTaskBaseline(transcriptPath: string): BackgroundTaskScan | undefined {
  try {
    return { transcriptPath, offset: fs.statSync(transcriptPath).size, pending: [] };
  } catch {
    return undefined;
  }
}

export function scanBackgroundTasks(
  transcriptPath: string,
  prior: BackgroundTaskScan | undefined,
): BackgroundTaskScan | undefined {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const resume = prior && prior.transcriptPath === transcriptPath && prior.offset <= size;
    const start = resume ? prior.offset : Math.max(0, size - FIRST_SCAN_BYTES);
    const pending = new Set(resume ? prior.pending : []);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const end = buf.lastIndexOf(0x0a) + 1;
    // A first scan that starts mid-file begins mid-line; that fragment fails to
    // parse and is skipped like any other unparseable line.
    for (const line of buf.subarray(0, end).toString("utf-8").split("\n")) {
      if (MARKERS.some(m => line.includes(m))) applyRecord(line, pending);
    }
    return { transcriptPath, offset: start + end, pending: [...pending] };
  } catch {
    return prior;
  } finally {
    fs.closeSync(fd);
  }
}

function applyRecord(line: string, pending: Set<string>): void {
  let rec: Record<string, any>;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (rec.isSidechain) return;
  if (rec.type === "user") {
    const result = rec.toolUseResult;
    if (typeof result?.backgroundTaskId === "string") pending.add(result.backgroundTaskId);
    if (result?.isAsync === true && typeof result.agentId === "string") pending.add(result.agentId);
    if (typeof result?.taskId === "string" && typeof result.timeoutMs === "number" && result.persistent !== true) {
      pending.add(result.taskId);
    }
    const content = rec.message?.content;
    if (typeof content === "string") finishFromNotification(content, pending);
  } else if (rec.type === "queue-operation" && typeof rec.content === "string") {
    finishFromNotification(rec.content, pending);
  } else if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
    for (const block of rec.message.content) {
      if (block?.type !== "tool_use" || (block.name !== "TaskStop" && block.name !== "KillShell")) continue;
      const id = block.input?.task_id ?? block.input?.shell_id;
      if (typeof id === "string") pending.delete(id);
    }
  }
}

function finishFromNotification(text: string, pending: Set<string>): void {
  if (!text.startsWith("<task-notification>") || !text.includes("<status>")) return;
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  if (id) pending.delete(id);
}
