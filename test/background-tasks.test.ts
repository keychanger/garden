// Background-task tracking from a Claude Code transcript. The record shapes
// below are copied from real 2.1.286 transcripts (trimmed to the fields read).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backgroundTaskBaseline, scanBackgroundTasks } from "../src/dashboard/background-tasks.js";

const bashLaunch = (id: string) => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content: [{ type: "tool_result", content: `Command running in background with ID: ${id}.` }] },
  toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: id },
});
const agentLaunch = (id: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: "Async agent launched" }] },
  toolUseResult: { isAsync: true, status: "async_launched", agentId: id },
});
const monitorLaunch = (id: string, persistent = false) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: `Monitor started (task ${id}, timeout 600000ms).` }] },
  toolUseResult: { taskId: id, timeoutMs: 600000, persistent },
});
const notification = (id: string, status?: string) => {
  const content = `<task-notification>\n<task-id>${id}</task-id>\n`
    + (status ? `<status>${status}</status>\n` : "<event>line</event>\n")
    + "</task-notification>";
  return { type: "user", message: { role: "user", content }, origin: { kind: "task-notification" } };
};
const taskStop = (id: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name: "TaskStop", input: { task_id: id } }] },
});

let dir: string;
let transcript: string;

function append(...records: unknown[]): void {
  fs.appendFileSync(transcript, records.map(r => JSON.stringify(r) + "\n").join(""));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-bg-tasks-"));
  transcript = path.join(dir, "sess.jsonl");
  fs.writeFileSync(transcript, "");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanBackgroundTasks", () => {
  it("keeps a background command pending until its completion notification", () => {
    append(bashLaunch("b13krek0m"), agentLaunch("a0e31ff2"));
    const first = scanBackgroundTasks(transcript, undefined);
    expect(first?.pending.sort()).toEqual(["a0e31ff2", "b13krek0m"]);

    append(notification("b13krek0m", "completed"));
    const second = scanBackgroundTasks(transcript, first);
    expect(second?.pending).toEqual(["a0e31ff2"]);

    append(notification("a0e31ff2", "failed"));
    expect(scanBackgroundTasks(transcript, second)?.pending).toEqual([]);
  });

  it("drops a task the agent stopped — TaskStop emits no notification", () => {
    // The dev-server shape: started in the background, stopped turns later.
    append(bashLaunch("b5iie9nck"));
    const first = scanBackgroundTasks(transcript, undefined);
    append(taskStop("b5iie9nck"));
    expect(scanBackgroundTasks(transcript, first)?.pending).toEqual([]);
  });

  it("keeps a Monitor pending until its stream ends", () => {
    // A worker that watches its checks through a Monitor ends its turn on that
    // wait just as one that backgrounds the command does.
    append(monitorLaunch("bdaiwm0r5"), notification("bdaiwm0r5"));
    const first = scanBackgroundTasks(transcript, undefined);
    expect(first?.pending).toEqual(["bdaiwm0r5"]);
    append(notification("bdaiwm0r5", "completed"));
    expect(scanBackgroundTasks(transcript, first)?.pending).toEqual([]);
  });

  it("does not count a persistent Monitor, which runs for the life of the session", () => {
    append(monitorLaunch("bpersist1", true));
    expect(scanBackgroundTasks(transcript, undefined)?.pending).toEqual([]);
  });

  it("does not treat a Monitor event as the end of a task", () => {
    append(bashLaunch("bn7jrr5xx"), notification("bn7jrr5xx"));
    expect(scanBackgroundTasks(transcript, undefined)?.pending).toEqual(["bn7jrr5xx"]);
  });

  it("ignores task markers that are only text inside some other record", () => {
    // An agent reading a transcript puts these strings in a tool result.
    append({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: '"backgroundTaskId":"bzzz" <task-notification>' }] },
    });
    expect(scanBackgroundTasks(transcript, undefined)?.pending).toEqual([]);
  });

  it("reads only what was appended since the last scan, leaving a partial line for next time", () => {
    append(bashLaunch("b1"));
    const first = scanBackgroundTasks(transcript, undefined)!;
    expect(first.offset).toBe(fs.statSync(transcript).size);

    const half = JSON.stringify(bashLaunch("b2"));
    fs.appendFileSync(transcript, half.slice(0, 20));
    const second = scanBackgroundTasks(transcript, first)!;
    expect(second.pending).toEqual(["b1"]);
    expect(second.offset).toBe(first.offset);

    fs.appendFileSync(transcript, half.slice(20) + "\n");
    expect(scanBackgroundTasks(transcript, second)?.pending.sort()).toEqual(["b1", "b2"]);
  });

  it("rescans from the start when the transcript changed under it", () => {
    append(bashLaunch("b1"));
    const stale = { transcriptPath: transcript, offset: 10_000, pending: ["old"] };
    expect(scanBackgroundTasks(transcript, stale)?.pending).toEqual(["b1"]);
    const otherFile = { transcriptPath: path.join(dir, "other.jsonl"), offset: 0, pending: ["old"] };
    expect(scanBackgroundTasks(transcript, otherFile)?.pending).toEqual(["b1"]);
  });

  it("returns undefined for a missing transcript", () => {
    expect(scanBackgroundTasks(path.join(dir, "missing.jsonl"), undefined)).toBeUndefined();
  });
});

describe("backgroundTaskBaseline", () => {
  it("starts after every launch already in the transcript — a new process holds none of them", () => {
    append(bashLaunch("b-before-restart"));
    const baseline = backgroundTaskBaseline(transcript)!;
    expect(baseline.pending).toEqual([]);
    append(bashLaunch("b-after"));
    expect(scanBackgroundTasks(transcript, baseline)?.pending).toEqual(["b-after"]);
  });
});
