import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

async function importRegistry() {
  return await import("../src/dashboard/registry.js");
}

describe("readRegistry", () => {
  it("returns empty on missing file", async () => {
    const { readRegistry } = await importRegistry();
    expect(readRegistry()).toEqual({ workers: {} });
  });

  it("returns empty on corrupted file", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, "bad json!!!");
    expect(readRegistry()).toEqual({ workers: {} });
  });
});

describe("addWorker / getWorkers", () => {
  it("persists and retrieves a worker", async () => {
    const { addWorker, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "abc", task: "fixing bugs" });
    const workers = getWorkers("proj");
    expect(workers).toHaveLength(1);
    expect(workers[0].name).toBe("bold-ash");
    expect(workers[0].task).toBe("fixing bugs");
  });

  it("appends to existing workers for same project", async () => {
    const { addWorker, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    addWorker("proj", { name: "calm-bay", sessionId: "b", task: "" });
    expect(getWorkers("proj")).toHaveLength(2);
  });

  it("returns empty array for unknown project", async () => {
    const { getWorkers } = await importRegistry();
    expect(getWorkers("unknown")).toEqual([]);
  });
});

describe("removeWorker", () => {
  it("removes by name and keeps others", async () => {
    const { addWorker, removeWorker, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    addWorker("proj", { name: "calm-bay", sessionId: "b", task: "" });
    removeWorker("proj", "bold-ash");
    const workers = getWorkers("proj");
    expect(workers).toHaveLength(1);
    expect(workers[0].name).toBe("calm-bay");
  });

  it("cleans up empty project key", async () => {
    const { addWorker, removeWorker, readRegistry } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    removeWorker("proj", "bold-ash");
    expect(readRegistry().workers["proj"]).toBeUndefined();
  });

  it("is a no-op for unknown worker", async () => {
    const { addWorker, removeWorker, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    removeWorker("proj", "nonexistent");
    expect(getWorkers("proj")).toHaveLength(1);
  });

  it("is a no-op for unknown project", async () => {
    const { removeWorker } = await importRegistry();
    expect(() => removeWorker("unknown", "any")).not.toThrow();
  });
});

describe("updateWorkerTask", () => {
  it("changes task for named worker", async () => {
    const { addWorker, updateWorkerTask, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    updateWorkerTask("proj", "bold-ash", "new task");
    expect(getWorkers("proj")[0].task).toBe("new task");
  });

  it("sets task to empty string when called with empty", async () => {
    const { addWorker, updateWorkerTask, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "had a task" });
    updateWorkerTask("proj", "bold-ash", "");
    expect(getWorkers("proj")[0].task).toBe("");
  });

  it("is a no-op for unknown worker", async () => {
    const { addWorker, updateWorkerTask, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "original" });
    updateWorkerTask("proj", "nonexistent", "new");
    expect(getWorkers("proj")[0].task).toBe("original");
  });

  it("is a no-op for unknown project", async () => {
    const { updateWorkerTask } = await importRegistry();
    expect(() => updateWorkerTask("unknown", "any", "task")).not.toThrow();
  });
});

describe("updateWorkerFields", () => {
  it("updates specified fields on a worker", async () => {
    const { addWorker, updateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    updateWorkerFields("proj", "bold-ash", {
      worktreePath: "/tmp/wt",
      branchName: "bold-ash",
      prState: "reviewing",
    });
    const worker = getWorkers("proj")[0];
    expect(worker.worktreePath).toBe("/tmp/wt");
    expect(worker.branchName).toBe("bold-ash");
    expect(worker.prState).toBe("reviewing");
  });

  it("preserves existing fields not in update", async () => {
    const { addWorker, updateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "original" });
    updateWorkerFields("proj", "bold-ash", { prState: "merged" });
    const worker = getWorkers("proj")[0];
    expect(worker.task).toBe("original");
    expect(worker.sessionId).toBe("a");
    expect(worker.prState).toBe("merged");
  });

  it("is a no-op for unknown worker", async () => {
    const { addWorker, updateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    updateWorkerFields("proj", "nonexistent", { prState: "merged" });
    expect(getWorkers("proj")[0].prState).toBeUndefined();
  });

  it("is a no-op for unknown project", async () => {
    const { updateWorkerFields } = await importRegistry();
    expect(() => updateWorkerFields("unknown", "any", { prState: "merged" })).not.toThrow();
  });

  it("can set role and parentWorker", async () => {
    const { addWorker, updateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "calm-bay", sessionId: "b", task: "" });
    updateWorkerFields("proj", "calm-bay", {
      role: "reviewer",
      parentWorker: "bold-ash",
    });
    const worker = getWorkers("proj")[0];
    expect(worker.role).toBe("reviewer");
    expect(worker.parentWorker).toBe("bold-ash");
  });
});

describe("batchUpdateWorkerFields", () => {
  it("updates multiple workers in a single write", async () => {
    const { addWorker, batchUpdateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    addWorker("proj", { name: "calm-bay", sessionId: "b", task: "" });
    batchUpdateWorkerFields([
      { project: "proj", workerName: "bold-ash", fields: { claudeStatus: "working" } },
      { project: "proj", workerName: "calm-bay", fields: { claudeStatus: "idle" } },
    ]);
    const workers = getWorkers("proj");
    expect(workers.find(w => w.name === "bold-ash")!.claudeStatus).toBe("working");
    expect(workers.find(w => w.name === "calm-bay")!.claudeStatus).toBe("idle");
  });

  it("skips unknown workers and projects without error", async () => {
    const { addWorker, batchUpdateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    batchUpdateWorkerFields([
      { project: "proj", workerName: "bold-ash", fields: { claudeStatus: "working" } },
      { project: "proj", workerName: "nonexistent", fields: { claudeStatus: "idle" } },
      { project: "unknown", workerName: "any", fields: { claudeStatus: "idle" } },
    ]);
    expect(getWorkers("proj")[0].claudeStatus).toBe("working");
  });

  it("is a no-op for empty updates array", async () => {
    const { batchUpdateWorkerFields } = await importRegistry();
    expect(() => batchUpdateWorkerFields([])).not.toThrow();
  });
});

describe("findWorkerByName", () => {
  it("finds a worker by name", async () => {
    const { addWorker, findWorkerByName } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "fixing" });
    const worker = findWorkerByName("proj", "bold-ash");
    expect(worker).toBeDefined();
    expect(worker!.sessionId).toBe("a");
  });

  it("returns undefined for unknown worker", async () => {
    const { addWorker, findWorkerByName } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    expect(findWorkerByName("proj", "nonexistent")).toBeUndefined();
  });

  it("returns undefined for unknown project", async () => {
    const { findWorkerByName } = await importRegistry();
    expect(findWorkerByName("unknown", "any")).toBeUndefined();
  });
});

describe("backward compatibility", () => {
  it("reads entries without new fields", async () => {
    const { readRegistry, getWorkers, REGISTRY_FILE } = await importRegistry();
    const oldFormat = {
      workers: {
        proj: [{ name: "bold-ash", sessionId: "a", task: "fix" }],
      },
    };
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(oldFormat));
    const workers = getWorkers("proj");
    expect(workers).toHaveLength(1);
    expect(workers[0].worktreePath).toBeUndefined();
    expect(workers[0].role).toBeUndefined();
  });
});

describe("withRegistryLock", () => {
  it("throws when lock is held by a live process", async () => {
    const { addWorker, REGISTRY_FILE } = await importRegistry();
    // Hold the lock ourselves: write our own PID so the holder appears alive.
    const lockFile = REGISTRY_FILE + ".lock";
    fs.writeFileSync(lockFile, String(process.pid));
    try {
      expect(() => addWorker("proj", { name: "x", sessionId: "s", task: "" })).toThrow(
        "Could not acquire registry lock after 500ms"
      );
    } finally {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }, 2000);
});

describe("getAllWorkerNames", () => {
  it("returns names across all projects", async () => {
    const { addWorker, getAllWorkerNames } = await importRegistry();
    addWorker("proj1", { name: "bold-ash", sessionId: "a", task: "" });
    addWorker("proj2", { name: "calm-bay", sessionId: "b", task: "" });
    const names = getAllWorkerNames();
    expect(names).toContain("bold-ash");
    expect(names).toContain("calm-bay");
    expect(names).toHaveLength(2);
  });

  it("returns empty array when no workers", async () => {
    const { getAllWorkerNames } = await importRegistry();
    expect(getAllWorkerNames()).toEqual([]);
  });
});
