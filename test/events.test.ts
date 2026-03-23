import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-events-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function loadEvents() {
  return await import("../src/events.js");
}

describe("emit", () => {
  it("creates the events file and appends an entry", async () => {
    const { emit, readEvents } = await loadEvents();
    emit("website", "task_done", { taskId: "a1b2" });

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].project).toBe("website");
    expect(events[0].event).toBe("task_done");
    expect(events[0].taskId).toBe("a1b2");
    expect(events[0].time).toBeDefined();
  });

  it("appends multiple events", async () => {
    const { emit, readEvents } = await loadEvents();
    emit("website", "session_start");
    emit("website", "task_start", { taskId: "a1b2" });
    emit("website", "task_done", { taskId: "a1b2" });

    const events = readEvents();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.event)).toEqual(["session_start", "task_start", "task_done"]);
  });
});

describe("readEvents", () => {
  it("returns empty array when no events file", async () => {
    const { readEvents } = await loadEvents();
    expect(readEvents()).toEqual([]);
  });

  it("filters by since date", async () => {
    const { emit, readEvents } = await loadEvents();
    emit("website", "old_event");

    // Use a future date to filter out the first event
    const after = new Date(Date.now() + 1000);
    emit("website", "new_event");

    // Both events have timestamps <= now, so a future cutoff should exclude both
    const events = readEvents(after);
    expect(events).toHaveLength(0);

    // A past cutoff should include both
    const allEvents = readEvents(new Date(Date.now() - 10000));
    expect(allEvents).toHaveLength(2);
  });
});
