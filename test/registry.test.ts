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
