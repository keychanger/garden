import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readTasks,
  addTask,
  nextTask,
  getTask,
  markDone,
  markBlocked,
  markInProgress,
  updateTask,
  removeTask,
  resetInProgress,
} from "../src/tasks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readTasks", () => {
  it("returns empty array when no tasks file exists", () => {
    expect(readTasks(tmpDir)).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    fs.mkdirSync(path.join(tmpDir, ".garden"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".garden", "tasks.json"), "not json");
    expect(readTasks(tmpDir)).toEqual([]);
  });
});

describe("addTask", () => {
  it("creates a pending task with an ID", () => {
    const task = addTask(tmpDir, "Fix the bug");
    expect(task.id).toMatch(/^[a-f0-9]{4}$/);
    expect(task.description).toBe("Fix the bug");
    expect(task.status).toBe("pending");
    expect(task.notes).toEqual([]);
  });

  it("creates a backlog task when status is specified", () => {
    const task = addTask(tmpDir, "Future work", "backlog");
    expect(task.status).toBe("backlog");
  });

  it("persists tasks across reads", () => {
    addTask(tmpDir, "First");
    addTask(tmpDir, "Second");
    const tasks = readTasks(tmpDir);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].description).toBe("First");
    expect(tasks[1].description).toBe("Second");
  });

  it("creates the .garden directory if missing", () => {
    addTask(tmpDir, "Test");
    expect(fs.existsSync(path.join(tmpDir, ".garden", "tasks.json"))).toBe(true);
  });
});

describe("nextTask", () => {
  it("returns null when no tasks exist", () => {
    expect(nextTask(tmpDir)).toBeNull();
  });

  it("returns the first pending task", () => {
    addTask(tmpDir, "First");
    addTask(tmpDir, "Second");
    const next = nextTask(tmpDir);
    expect(next?.description).toBe("First");
  });

  it("skips done tasks", () => {
    const t1 = addTask(tmpDir, "Done task");
    addTask(tmpDir, "Pending task");
    markDone(tmpDir, t1.id);
    const next = nextTask(tmpDir);
    expect(next?.description).toBe("Pending task");
  });

  it("skips backlog tasks", () => {
    addTask(tmpDir, "Backlog item", "backlog");
    addTask(tmpDir, "Pending item");
    const next = nextTask(tmpDir);
    expect(next?.description).toBe("Pending item");
  });

  it("prefers in_progress over pending", () => {
    const t1 = addTask(tmpDir, "Pending");
    const t2 = addTask(tmpDir, "In progress");
    markInProgress(tmpDir, t2.id);
    const next = nextTask(tmpDir);
    expect(next?.id).toBe(t2.id);
  });
});

describe("getTask", () => {
  it("returns a task by ID", () => {
    const created = addTask(tmpDir, "Find me");
    const found = getTask(tmpDir, created.id);
    expect(found?.description).toBe("Find me");
  });

  it("returns null for unknown ID", () => {
    expect(getTask(tmpDir, "zzzz")).toBeNull();
  });
});

describe("status transitions", () => {
  it("marks a task done with a completion timestamp", () => {
    const task = addTask(tmpDir, "Do it");
    const done = markDone(tmpDir, task.id);
    expect(done.status).toBe("done");
    expect(done.completed).toBeDefined();
  });

  it("marks a task blocked with a reason", () => {
    const task = addTask(tmpDir, "Try it");
    const blocked = markBlocked(tmpDir, task.id, "Need credentials");
    expect(blocked.status).toBe("blocked");
    expect(blocked.notes).toContain("Need credentials");
  });

  it("marks a task in_progress", () => {
    const task = addTask(tmpDir, "Start it");
    const started = markInProgress(tmpDir, task.id);
    expect(started.status).toBe("in_progress");
  });

  it("throws for unknown task ID", () => {
    expect(() => markDone(tmpDir, "zzzz")).toThrow("Task not found: zzzz");
  });
});

describe("updateTask", () => {
  it("updates status", () => {
    const task = addTask(tmpDir, "Update me");
    const updated = updateTask(tmpDir, task.id, { status: "blocked" });
    expect(updated.status).toBe("blocked");
  });

  it("adds a note", () => {
    const task = addTask(tmpDir, "Note me");
    updateTask(tmpDir, task.id, { note: "First note" });
    const updated = updateTask(tmpDir, task.id, { note: "Second note" });
    expect(updated.notes).toEqual(["First note", "Second note"]);
  });

  it("updates description", () => {
    const task = addTask(tmpDir, "Old description");
    const updated = updateTask(tmpDir, task.id, { description: "New description" });
    expect(updated.description).toBe("New description");
  });
});

describe("removeTask", () => {
  it("removes a task by ID", () => {
    const task = addTask(tmpDir, "Remove me");
    removeTask(tmpDir, task.id);
    expect(readTasks(tmpDir)).toHaveLength(0);
  });

  it("throws for unknown task ID", () => {
    expect(() => removeTask(tmpDir, "zzzz")).toThrow("Task not found: zzzz");
  });
});

describe("resetInProgress", () => {
  it("resets in_progress tasks to pending", () => {
    const t1 = addTask(tmpDir, "Working");
    const t2 = addTask(tmpDir, "Also working");
    addTask(tmpDir, "Still pending");
    markInProgress(tmpDir, t1.id);
    markInProgress(tmpDir, t2.id);

    const count = resetInProgress(tmpDir);
    expect(count).toBe(2);

    const tasks = readTasks(tmpDir);
    expect(tasks.filter((t) => t.status === "in_progress")).toHaveLength(0);
    expect(tasks.filter((t) => t.status === "pending")).toHaveLength(3);
  });

  it("returns 0 when nothing to reset", () => {
    addTask(tmpDir, "Pending");
    expect(resetInProgress(tmpDir)).toBe(0);
  });
});
