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

  it("returns empty when top-level is missing the workers field", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ unrelated: 1 }));
    expect(readRegistry()).toEqual({ workers: {} });
  });

  it("returns empty when workers is the wrong type (array)", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    // workers must be Record<string, WorkerEntry[]>. An array at this
    // position would pass typeof===object but break getWorkers' lookup.
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ workers: [] }));
    expect(readRegistry()).toEqual({ workers: {} });
  });

  it("returns empty when an entry is missing its `name` field", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: { proj: [{ sessionId: "a", task: "" }] },
    }));
    expect(readRegistry()).toEqual({ workers: {} });
  });

  it("preserves legacy entries that lack optional fields (baseBranch, workflow, etc.)", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    // Validation tolerates missing optional fields — only `name` is required.
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: { proj: [{ name: "legacy-worker", sessionId: "a", task: "old" }] },
    }));
    const reg = readRegistry();
    expect(reg.workers.proj).toHaveLength(1);
    expect(reg.workers.proj[0].name).toBe("legacy-worker");
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

  // Deep-merge regression: a partial trellis update must preserve the other
  // trellis fields. A naive shallow Object.assign would have replaced the
  // whole sub-object and dropped name/path/iteration on every poller write.
  it("deep-merges the trellis sub-object instead of clobbering it", async () => {
    const { addWorker, updateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", {
      name: "swift-vine", sessionId: "s1", task: "", workflow: "trellis",
      trellis: { name: "auth", path: "/tmp/auth.md", iteration: 2, maxIterations: 30 },
    });
    updateWorkerFields("proj", "swift-vine", {
      trellis: { lastVerdict: "DRIFT", lastDrift: ["1. [tests] missing"] },
    });
    const t = getWorkers("proj")[0].trellis!;
    expect(t.name).toBe("auth");
    expect(t.path).toBe("/tmp/auth.md");
    expect(t.iteration).toBe(2);
    expect(t.maxIterations).toBe(30);
    expect(t.lastVerdict).toBe("DRIFT");
    expect(t.lastDrift).toEqual(["1. [tests] missing"]);
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

  it("deep-merges the trellis sub-object and logs prState transitions", async () => {
    const { addWorker, batchUpdateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", {
      name: "swift-vine", sessionId: "s1", task: "",
      workflow: "trellis", prState: "working",
      trellis: { name: "auth", path: "/tmp/auth.md", iteration: 1 },
    });
    batchUpdateWorkerFields([
      {
        project: "proj", workerName: "swift-vine",
        fields: {
          prState: "reviewing",
          trellis: { lastVerdict: "DRIFT" },
        },
      },
    ]);
    const w = getWorkers("proj")[0];
    expect(w.prState).toBe("reviewing");
    expect(w.trellis?.name).toBe("auth");
    expect(w.trellis?.iteration).toBe(1);
    expect(w.trellis?.lastVerdict).toBe("DRIFT");
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
        /Could not acquire registry lock after \d+ms/
      );
    } finally {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }, 5000);
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

// Trellis workflow adds an optional `trellis` sub-object to WorkerEntry
// holding all per-vine state. Round-trip it through addWorker → readRegistry
// to confirm shape changes don't break the registry's persistence contract.
// See WORKFLOWS.md "Worker entry additions".
describe("trellis WorkerEntry fields", () => {
  it("round-trips every trellis sub-object field plus failingReason", async () => {
    const { addWorker, getWorkers } = await importRegistry();
    addWorker("proj", {
      name: "swift-oak",
      sessionId: "s1",
      task: "",
      workflow: "trellis",
      failingReason: "trellis-flagged",
      trellis: {
        name: "auth-rewrite",
        path: "/tmp/auth-rewrite.md",
        iteration: 3,
        maxIterations: 30,
        lastVerdict: "DRIFT",
        lastDrift: ["[surface] foo() missing", "[tests] no test"],
        alignedCount: 7,
        driftHistory: [["a"], ["b"]],
        shaHistory: ["sha1", "sha2"],
        stagnationConfirmedAt: 1234567890,
        flaggedClauses: ["line 47 contradicts line 91"],
        aligned: true,
        modelFallbackAt: 1234567899,
        workerModel: "sonnet",
      },
    });
    const w = getWorkers("proj")[0];
    expect(w.workflow).toBe("trellis");
    expect(w.failingReason).toBe("trellis-flagged");
    const t = w.trellis!;
    expect(t.name).toBe("auth-rewrite");
    expect(t.path).toBe("/tmp/auth-rewrite.md");
    expect(t.iteration).toBe(3);
    expect(t.maxIterations).toBe(30);
    expect(t.lastVerdict).toBe("DRIFT");
    expect(t.lastDrift).toEqual(["[surface] foo() missing", "[tests] no test"]);
    expect(t.alignedCount).toBe(7);
    expect(t.driftHistory).toEqual([["a"], ["b"]]);
    expect(t.shaHistory).toEqual(["sha1", "sha2"]);
    expect(t.stagnationConfirmedAt).toBe(1234567890);
    expect(t.flaggedClauses).toEqual(["line 47 contradicts line 91"]);
    expect(t.aligned).toBe(true);
    expect(t.modelFallbackAt).toBe(1234567899);
    expect(t.workerModel).toBe("sonnet");
  });

  it("default workers omit trellis fields and round-trip cleanly", async () => {
    const { addWorker, getWorkers } = await importRegistry();
    addWorker("proj", {
      name: "bold-ash",
      sessionId: "s2",
      task: "",
      workflow: "default",
    });
    const w = getWorkers("proj")[0];
    expect(w.workflow).toBe("default");
    expect(w.trellis).toBeUndefined();
    expect(w.failingReason).toBeUndefined();
  });

  it("readRegistry migrates legacy flat trellis* fields into the nested trellis sub-object", async () => {
    // Hand-write a legacy-shape registry to disk: pre-migration entries
    // carry trellis* fields directly on the entry rather than nested.
    // readRegistry should detect and migrate them on read; the legacy
    // keys disappear and the nested shape appears with the same values.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { SESSIONS_DIR } = await import("../src/config.js");
    const registryFile = path.join(SESSIONS_DIR, "dashboard.registry.json");
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({
      workers: {
        proj: [{
          name: "legacy-vine",
          sessionId: "s1",
          task: "",
          workflow: "trellis",
          // Legacy flat fields:
          trellisName: "auth",
          trellisPath: "/tmp/auth.md",
          trellisIteration: 5,
          trellisMaxIterations: 30,
          trellisLastVerdict: "DRIFT",
          trellisAligned: false,
          workerModel: "sonnet",
        }],
      },
    }, null, 2));

    const { readRegistry } = await importRegistry();
    const reg = readRegistry();
    const w = reg.workers.proj[0];
    expect(w.trellis).toBeDefined();
    expect(w.trellis?.name).toBe("auth");
    expect(w.trellis?.path).toBe("/tmp/auth.md");
    expect(w.trellis?.iteration).toBe(5);
    expect(w.trellis?.maxIterations).toBe(30);
    expect(w.trellis?.lastVerdict).toBe("DRIFT");
    expect(w.trellis?.aligned).toBe(false);
    expect(w.trellis?.workerModel).toBe("sonnet");
    // Legacy fields must be stripped — the entry shape after migration
    // matches what writers from this build produce.
    expect((w as Record<string, unknown>).trellisName).toBeUndefined();
    expect((w as Record<string, unknown>).workerModel).toBeUndefined();
  });

  it("strips legacy flat fields when both shapes are present (nested form wins)", async () => {
    // Edge case: a registry written by a mid-rollout build could end up with
    // both shapes on the same entry. The nested form is authoritative; the
    // legacy keys must be stripped so subsequent writes don't preserve them.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { SESSIONS_DIR } = await import("../src/config.js");
    const registryFile = path.join(SESSIONS_DIR, "dashboard.registry.json");
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({
      workers: {
        proj: [{
          name: "mixed-vine",
          sessionId: "s1",
          task: "",
          workflow: "trellis",
          // Both shapes present:
          trellisName: "stale-name",
          trellisIteration: 99,
          trellis: { name: "fresh-name", path: "/tmp/fresh.md", iteration: 7 },
        }],
      },
    }, null, 2));

    const { readRegistry } = await importRegistry();
    const w = readRegistry().workers.proj[0];
    expect(w.trellis?.name).toBe("fresh-name");
    expect(w.trellis?.iteration).toBe(7);
    expect((w as Record<string, unknown>).trellisName).toBeUndefined();
    expect((w as Record<string, unknown>).trellisIteration).toBeUndefined();
  });
});
