import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const env = useTmpHome();

async function importRegistry() {
  return await import("../src/dashboard/registry.js");
}

function mkEntry(partial: Partial<WorkerEntry> & { name: string }): WorkerEntry {
  return { sessionId: "s", task: "", ...partial };
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

  it("rejects an entry whose trusted field is present with the wrong type (forgery guard)", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    // The registry sits in a sandbox-writable dir; these fields are consumed
    // without re-validation to build paths / git targets / dispatch. A forged
    // wrong-typed value must be rejected (quarantined to empty), not trusted.
    for (const bad of [
      { name: "w", worktreePath: { evil: "../../etc" } },
      { name: "w", baseBranch: 42 },
      { name: "w", prState: ["reviewing"] },
      { name: "w", sessionId: 7 },
      { name: "w", ciNoRuns: { sha: "abc", since: "now" } },
    ]) {
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ workers: { proj: [bad] } }));
      expect(readRegistry()).toEqual({ workers: {} });
    }
  });

  it("accepts an entry whose trusted fields are present with the right type", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: { proj: [{
        name: "ok", prState: "reviewing", baseBranch: "main",
        worktreePath: "/wt/proj/ok", sessionId: "abc",
        ciNoRuns: { sha: "deadbeef", since: 123 },
      }] },
    }));
    expect(readRegistry().workers.proj[0]).toMatchObject({
      name: "ok", ciNoRuns: { sha: "deadbeef", since: 123 },
    });
  });
});

describe("registry durability", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function backupSiblings(REGISTRY_FILE: string, suffix: string): string[] {
    const dir = path.dirname(REGISTRY_FILE);
    const prefix = `${path.basename(REGISTRY_FILE)}.${suffix}-`;
    return fs.readdirSync(dir).filter(f => f.startsWith(prefix));
  }

  it("quarantines a corrupt file instead of silently overwriting it", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, "bad json!!!");
    expect(readRegistry()).toEqual({ workers: {} });
    // Original moved aside for recovery; a .corrupt-<ts> sibling exists.
    expect(fs.existsSync(REGISTRY_FILE)).toBe(false);
    expect(backupSiblings(REGISTRY_FILE, "corrupt")).toHaveLength(1);
  });

  it("quarantines a shape-invalid file", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ workers: [] }));
    expect(readRegistry()).toEqual({ workers: {} });
    expect(backupSiblings(REGISTRY_FILE, "corrupt")).toHaveLength(1);
  });

  it("after quarantine, a fresh addWorker recreates the registry", async () => {
    const { readRegistry, addWorker, getWorkers, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, "{{{ not json");
    readRegistry(); // triggers quarantine
    addWorker("proj", { name: "fresh", sessionId: "s", task: "" });
    expect(getWorkers("proj")).toHaveLength(1);
  });

  it("refuses to persist a registry built from a transient (tainted) read", async () => {
    const mod = await importRegistry();
    const { addWorker, readRegistry, writeRegistry, getWorkers, REGISTRY_FILE } = mod;
    // Seed a real, intact registry with a worker.
    addWorker("proj", { name: "keep-me", sessionId: "s", task: "important" });
    const good = fs.readFileSync(REGISTRY_FILE, "utf-8");

    // Simulate a transient IO failure on the next read (file stays intact on
    // disk). readRegistry must return an empty result that writeRegistry then
    // refuses to persist — otherwise the worker would be erased.
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw err; });

    const tainted = readRegistry();
    expect(tainted).toEqual({ workers: {} });

    writeRegistry(tainted); // must be a no-op, not a clobber

    // The intact file is untouched and the worker survives.
    expect(fs.readFileSync(REGISTRY_FILE, "utf-8")).toBe(good);
    expect(getWorkers("proj")).toHaveLength(1);
  });

  it("refuses to persist a registry built from a tainted stat failure", async () => {
    const { addWorker, readRegistry, writeRegistry, getWorkers, REGISTRY_FILE } = await importRegistry();
    // Seed a real, intact registry, then fault statSync (the first fs call in
    // readRegistry) so the intact-but-unreadable branch tags the empty result.
    addWorker("proj", { name: "keep-me", sessionId: "s", task: "important" });
    const good = fs.readFileSync(REGISTRY_FILE, "utf-8");

    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.spyOn(fs, "statSync").mockImplementationOnce(() => { throw err; });

    const tainted = readRegistry();
    expect(tainted).toEqual({ workers: {} });

    writeRegistry(tainted); // must be a no-op, not a clobber

    expect(fs.readFileSync(REGISTRY_FILE, "utf-8")).toBe(good);
    expect(getWorkers("proj")).toHaveLength(1);
  });

  it("snapshots the registry before a write that shrinks the worker set", async () => {
    const { addWorker, removeWorker, REGISTRY_FILE } = await importRegistry();
    addWorker("proj", { name: "a", sessionId: "1", task: "" });
    addWorker("proj", { name: "b", sessionId: "2", task: "" });
    addWorker("proj", { name: "c", sessionId: "3", task: "" });
    expect(backupSiblings(REGISTRY_FILE, "bak")).toHaveLength(0); // growth: no backup
    removeWorker("proj", "b"); // shrink 3 -> 2
    const bak = backupSiblings(REGISTRY_FILE, "bak");
    expect(bak).toHaveLength(1);
    // The snapshot holds the pre-shrink state (all three workers).
    const snap = JSON.parse(fs.readFileSync(path.join(path.dirname(REGISTRY_FILE), bak[0]), "utf-8"));
    expect(snap.workers.proj).toHaveLength(3);
  });
});

describe("mutateRegistry", () => {
  it("persists the mutation when the callback reports a change", async () => {
    const { addWorker, mutateRegistry, getWorkers } = await importRegistry();
    addWorker("proj", { name: "a", sessionId: "1", task: "orig" });
    mutateRegistry((reg) => {
      reg.workers.proj[0].task = "updated";
      return true;
    });
    expect(getWorkers("proj")[0].task).toBe("updated");
  });

  it("does not write when the callback reports no change", async () => {
    const { addWorker, mutateRegistry, getWorkers } = await importRegistry();
    addWorker("proj", { name: "a", sessionId: "1", task: "orig" });
    mutateRegistry((reg) => {
      reg.workers.proj[0].task = "ignored"; // mutated in memory, but...
      return false;                          // ...reported no change -> no write
    });
    expect(getWorkers("proj")[0].task).toBe("orig");
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

  it("allocates a globally unique name from the locked registry snapshot", async () => {
    const { addWorker, addWorkerWithUniqueName, getWorkers } = await importRegistry();
    addWorker("proj1", mkEntry({ name: "bold-ash" }));

    const entry = addWorkerWithUniqueName("proj2", existingNames => {
      expect(existingNames).toEqual(["bold-ash"]);
      return mkEntry({ name: "calm-bay", worktreePath: "/tmp/calm-bay" });
    });

    expect(entry.worktreePath).toBe("/tmp/calm-bay");
    expect(getWorkers("proj2")).toEqual([
      expect.objectContaining({ name: "calm-bay", worktreePath: "/tmp/calm-bay" }),
    ]);
  });

  it("rejects a duplicate name without modifying the registry", async () => {
    const { addWorker, addWorkerWithUniqueName, getWorkers } = await importRegistry();
    addWorker("proj1", mkEntry({ name: "bold-ash" }));

    expect(() => addWorkerWithUniqueName("proj2", () => mkEntry({ name: "bold-ash" })))
      .toThrow("Worker name is already registered: bold-ash");
    expect(getWorkers("proj2")).toEqual([]);
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

  // Same regression check for the grow sub-object — every iteration's
  // increment writes only `{ grow: { iteration: N } }`, so the seed and
  // maxIterations must survive without being clobbered.
  it("deep-merges the grow sub-object instead of clobbering it", async () => {
    const { addWorker, updateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", {
      name: "tall-fern", sessionId: "s1", task: "", workflow: "grow",
      grow: { seed: "harden auth flow", iteration: 0, maxIterations: 5 },
    });
    updateWorkerFields("proj", "tall-fern", {
      grow: { iteration: 3 },
    });
    const g = getWorkers("proj")[0].grow!;
    expect(g.seed).toBe("harden auth flow");
    expect(g.maxIterations).toBe(5);
    expect(g.iteration).toBe(3);
  });
});

describe("batchUpdateWorkerFields", () => {
  it("updates multiple workers in a single write", async () => {
    const { addWorker, batchUpdateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    addWorker("proj", { name: "calm-bay", sessionId: "b", task: "" });
    batchUpdateWorkerFields([
      { project: "proj", workerName: "bold-ash", fields: { agentStatus: "working" } },
      { project: "proj", workerName: "calm-bay", fields: { agentStatus: "idle" } },
    ]);
    const workers = getWorkers("proj");
    expect(workers.find(w => w.name === "bold-ash")!.agentStatus).toBe("working");
    expect(workers.find(w => w.name === "calm-bay")!.agentStatus).toBe("idle");
  });

  it("skips unknown workers and projects without error", async () => {
    const { addWorker, batchUpdateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", { name: "bold-ash", sessionId: "a", task: "" });
    batchUpdateWorkerFields([
      { project: "proj", workerName: "bold-ash", fields: { agentStatus: "working" } },
      { project: "proj", workerName: "nonexistent", fields: { agentStatus: "idle" } },
      { project: "unknown", workerName: "any", fields: { agentStatus: "idle" } },
    ]);
    expect(getWorkers("proj")[0].agentStatus).toBe("working");
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

  it("deep-merges the grow sub-object across batch writes", async () => {
    const { addWorker, batchUpdateWorkerFields, getWorkers } = await importRegistry();
    addWorker("proj", {
      name: "tall-fern", sessionId: "s1", task: "", workflow: "grow",
      grow: { seed: "polish dashboard", iteration: 0, maxIterations: 5 },
    });
    batchUpdateWorkerFields([
      {
        project: "proj", workerName: "tall-fern",
        fields: { grow: { iteration: 1 } },
      },
    ]);
    const w = getWorkers("proj")[0];
    expect(w.grow?.seed).toBe("polish dashboard");
    expect(w.grow?.iteration).toBe(1);
    expect(w.grow?.maxIterations).toBe(5);
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

  it("readRegistry migrates legacy claudeStatus/lastHookAt to agentStatus/lastEventAt", async () => {
    // Pre-rename entries (and writes from an in-flight old binary during the
    // rebuild window) carry the legacy field names on disk. readRegistry
    // migrates on read, exactly like the trellis migration above.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { SESSIONS_DIR } = await import("../src/config.js");
    const registryFile = path.join(SESSIONS_DIR, "dashboard.registry.json");
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({
      workers: {
        proj: [{
          name: "legacy-status",
          sessionId: "s1",
          task: "",
          claudeStatus: "working",
          lastHookAt: 1234567,
        }],
      },
    }, null, 2));

    const { readRegistry } = await importRegistry();
    const w = readRegistry().workers.proj[0];
    expect(w.agentStatus).toBe("working");
    expect(w.lastEventAt).toBe(1234567);
    expect((w as Record<string, unknown>).claudeStatus).toBeUndefined();
    expect((w as Record<string, unknown>).lastHookAt).toBeUndefined();
  });

  it("keeps the new status fields when both old and new names are present", async () => {
    // A fresh old-binary write landing on an already-migrated entry leaves
    // both names on disk; the migrated name is authoritative and the legacy
    // key is stripped so subsequent writes don't resurrect it.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { SESSIONS_DIR } = await import("../src/config.js");
    const registryFile = path.join(SESSIONS_DIR, "dashboard.registry.json");
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({
      workers: {
        proj: [{
          name: "mixed-status",
          sessionId: "s1",
          task: "",
          claudeStatus: "idle",
          agentStatus: "working",
          lastHookAt: 1,
          lastEventAt: 2,
        }],
      },
    }, null, 2));

    const { readRegistry } = await importRegistry();
    const w = readRegistry().workers.proj[0];
    expect(w.agentStatus).toBe("working");
    expect(w.lastEventAt).toBe(2);
    expect((w as Record<string, unknown>).claudeStatus).toBeUndefined();
    expect((w as Record<string, unknown>).lastHookAt).toBeUndefined();
  });
});

describe("readRegistry mtime cache", () => {
  it("returns a fresh clone each call so callers can mutate without polluting the cache", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: { proj: [{ name: "alpha", sessionId: "s1", task: "" }] },
    }));

    const first = readRegistry();
    first.workers.proj.push({ name: "fake", sessionId: "x", task: "" });

    const second = readRegistry();
    // The mutation on `first` must not leak into `second`. The read-modify-
    // writeRegistry pattern (under withRegistryLock) relies on this.
    expect(second.workers.proj).toHaveLength(1);
    expect(second.workers.proj[0].name).toBe("alpha");
  });

  it("invalidates after writeRegistry so callers see freshly-written content", async () => {
    const { readRegistry, writeRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: { proj: [{ name: "alpha", sessionId: "s1", task: "" }] },
    }));

    // Prime the cache.
    expect(readRegistry().workers.proj[0].name).toBe("alpha");

    // Write through the cached path (mtime would change anyway, but the
    // cache is invalidated explicitly to guard against sub-millisecond mtime
    // resolution clamps that happen on some filesystems).
    writeRegistry({
      workers: { proj: [{ name: "beta", sessionId: "s2", task: "" }] },
    });

    expect(readRegistry().workers.proj[0].name).toBe("beta");
  });

  it("picks up cross-process writes via mtime change", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: { proj: [{ name: "alpha", sessionId: "s1", task: "" }] },
    }));
    expect(readRegistry().workers.proj[0].name).toBe("alpha");

    // Simulate an out-of-process write: change content + bump mtime.
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: { proj: [{ name: "gamma", sessionId: "s9", task: "" }] },
    }));
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(REGISTRY_FILE, future, future);

    expect(readRegistry().workers.proj[0].name).toBe("gamma");
  });
});

describe("worker ordering helpers", () => {
  it("workerFreshness prefers lastEventAt, falls back to createdAt, then 0", async () => {
    const { workerFreshness } = await importRegistry();
    expect(workerFreshness(mkEntry({ name: "a", lastEventAt: 500, createdAt: 100 }))).toBe(500);
    expect(workerFreshness(mkEntry({ name: "b", createdAt: 100 }))).toBe(100);
    expect(workerFreshness(mkEntry({ name: "c" }))).toBe(0);
  });

  it("workerSortFreshness prefers lastStateChangeAt, then lastEventAt, then createdAt, then 0", async () => {
    const { workerSortFreshness } = await importRegistry();
    expect(workerSortFreshness(
      mkEntry({ name: "a", lastStateChangeAt: 900, lastEventAt: 500, createdAt: 100 }))).toBe(900);
    expect(workerSortFreshness(mkEntry({ name: "b", lastEventAt: 500, createdAt: 100 }))).toBe(500);
    expect(workerSortFreshness(mkEntry({ name: "c", createdAt: 100 }))).toBe(100);
    expect(workerSortFreshness(mkEntry({ name: "d" }))).toBe(0);
  });

  it("workerSortTier classifies by attention", async () => {
    const { workerSortTier } = await importRegistry();
    expect(workerSortTier(mkEntry({ name: "a", prState: "failing" }))).toBe(0);
    expect(workerSortTier(mkEntry({ name: "b", agentStatus: "asking" }))).toBe(0);
    expect(workerSortTier(mkEntry({ name: "c", agentStatus: "ready" }))).toBe(1);
    expect(workerSortTier(mkEntry({ name: "d", agentStatus: "loading" }))).toBe(1);
    expect(workerSortTier(mkEntry({ name: "e", prState: "reviewing" }))).toBe(3);
    expect(workerSortTier(mkEntry({ name: "f", prState: "merge-pending" }))).toBe(3);
    expect(workerSortTier(mkEntry({ name: "g", prState: "merged" }))).toBe(3);
    expect(workerSortTier(mkEntry({ name: "h", agentStatus: "idle" }))).toBe(2);
    expect(workerSortTier(mkEntry({ name: "i", agentStatus: "working" }))).toBe(2);
    // paused (operator hold) is an active/recent state, not a "needs you" one.
    expect(workerSortTier(mkEntry({ name: "k", agentStatus: "paused" }))).toBe(2);
    expect(workerSortTier(mkEntry({ name: "j", prState: "done" }))).toBe(4);
  });

  it("the in-flight band sits below active but is still classified by prState", async () => {
    const { workerSortTier } = await importRegistry();
    // in flight (3) is below active (2) — it descends toward done.
    expect(workerSortTier(mkEntry({ name: "w", agentStatus: "working" }))).toBe(2);
    expect(workerSortTier(mkEntry({ name: "r", prState: "reviewing" }))).toBe(3);
    // A stale ready/loading agentStatus does not pull a reviewing worker up into
    // the new band — prState classification wins (STATUS.md invariant).
    expect(workerSortTier(mkEntry({ name: "a", agentStatus: "ready", prState: "reviewing" }))).toBe(3);
  });

  it("sorts blocked-on-you to the top and done to the bottom, across tiers", async () => {
    const { compareWorkerFreshness } = await importRegistry();
    const sorted = [
      mkEntry({ name: "done-1", prState: "done", lastEventAt: 9999 }),
      mkEntry({ name: "idle-1", agentStatus: "idle", lastEventAt: 5000 }),
      mkEntry({ name: "new-1", agentStatus: "ready", createdAt: 1000 }),
      mkEntry({ name: "fail-1", prState: "failing", lastEventAt: 10 }),
      mkEntry({ name: "review-1", prState: "reviewing", lastEventAt: 20 }),
    ].sort(compareWorkerFreshness);
    // needs-you → new → active → in-flight → done (in-flight now below active).
    expect(sorted.map(e => e.name)).toEqual(["fail-1", "new-1", "idle-1", "review-1", "done-1"]);
  });

  it("within a tier, fresher sorts first but same-60s-bucket falls back to name", async () => {
    const { compareWorkerFreshness } = await importRegistry();
    const base = 60_000 * 100; // aligned to a 60s bucket boundary
    // A full bucket apart: fresher wins regardless of name.
    const fresher = mkEntry({ name: "zzz", agentStatus: "idle", lastEventAt: base + 120_000 });
    const older = mkEntry({ name: "aaa", agentStatus: "idle", lastEventAt: base });
    expect([older, fresher].sort(compareWorkerFreshness).map(e => e.name)).toEqual(["zzz", "aaa"]);
    // Same 60s bucket: name-stable, so a flurry of events doesn't reshuffle.
    const a = mkEntry({ name: "aaa", agentStatus: "idle", lastEventAt: base + 1_000 });
    const b = mkEntry({ name: "bbb", agentStatus: "idle", lastEventAt: base + 59_000 });
    expect([b, a].sort(compareWorkerFreshness).map(e => e.name)).toEqual(["aaa", "bbb"]);
  });

  it("orders by lastStateChangeAt, not the heartbeat — a heartbeat bump doesn't reshuffle", async () => {
    const { compareWorkerFreshness } = await importRegistry();
    const base = 60_000 * 100;
    // alpha last changed state a full bucket *before* beta, so beta sorts first
    // by state-change time even though alpha's heartbeat (lastEventAt) is newer.
    const alpha = mkEntry({
      name: "alpha", agentStatus: "working",
      lastStateChangeAt: base, lastEventAt: base + 600_000,
    });
    const beta = mkEntry({
      name: "beta", agentStatus: "working",
      lastStateChangeAt: base + 120_000, lastEventAt: base + 120_000,
    });
    expect([alpha, beta].sort(compareWorkerFreshness).map(e => e.name)).toEqual(["beta", "alpha"]);

    // A working agent's silent heartbeat advances lastEventAt across many
    // buckets, but lastStateChangeAt is fixed — so the order is unchanged. This
    // is the regression: ordering must not drift while the agent just works.
    const alphaAfterHeartbeats = mkEntry({
      name: "alpha", agentStatus: "working",
      lastStateChangeAt: base, lastEventAt: base + 5_000_000,
    });
    expect([alphaAfterHeartbeats, beta].sort(compareWorkerFreshness).map(e => e.name))
      .toEqual(["beta", "alpha"]);
  });

  it("isWorkerStale is true only for active-band workers untouched past WORKER_STALE_MS", async () => {
    const { isWorkerStale, WORKER_STALE_MS } = await importRegistry();
    const now = 1_700_000_000_000;
    const old = now - WORKER_STALE_MS - 1;
    const recent = now - 1_000;
    expect(isWorkerStale(mkEntry({ name: "a", agentStatus: "idle", lastEventAt: old }), now)).toBe(true);
    expect(isWorkerStale(mkEntry({ name: "b", agentStatus: "idle", lastEventAt: recent }), now)).toBe(false);
    // Blocked / done never dim, even when ancient.
    expect(isWorkerStale(mkEntry({ name: "c", prState: "failing", lastEventAt: old }), now)).toBe(false);
    expect(isWorkerStale(mkEntry({ name: "d", prState: "done", lastEventAt: old }), now)).toBe(false);
    // In-flight (now the band below active) never dims — guards the stale-dim
    // staying keyed on the active band after the tier renumber.
    expect(isWorkerStale(mkEntry({ name: "f", prState: "reviewing", lastEventAt: old }), now)).toBe(false);
    // paused is an active-band state but is an explicit operator hold (bold cyan) — never dimmed.
    expect(isWorkerStale(mkEntry({ name: "e", agentStatus: "paused", lastEventAt: old }), now)).toBe(false);
  });
});

describe("resolveResumeAgentStatus", () => {
  it("parks an interrupted (mid-turn) worker at the ready cold-start sentinel", async () => {
    const { resolveResumeAgentStatus } = await importRegistry();
    // agentStatus="working" at rebuild (tmux server crash, no pane-died) →
    expect(resolveResumeAgentStatus({ agentStatus: "working" })).toBe("ready");
    // pane-died recorded the interrupt flag but reset agentStatus to "exited" →
    expect(resolveResumeAgentStatus({ agentStatus: "exited", interruptedWhileWorking: true })).toBe("ready");
  });

  it("preserves an operator hold and a pending question across the restart", async () => {
    const { resolveResumeAgentStatus } = await importRegistry();
    expect(resolveResumeAgentStatus({ agentStatus: "paused" })).toBe("paused");
    expect(resolveResumeAgentStatus({ agentStatus: "asking" })).toBe("asking");
  });

  it("keeps a held/asking worker held even when an interrupt flag still lingers", async () => {
    const { resolveResumeAgentStatus } = await importRegistry();
    // Regression: an owed interruptedWhileWorking flag can outlive an operator
    // hold (holdWorker doesn't clear it; the deferred continue skips a paused
    // worker without clearing it). The hold is the most-recent explicit signal
    // and must win — otherwise bounce/rebuild routes to "ready" and dispatches
    // an auto-continue that defeats the hold.
    expect(resolveResumeAgentStatus({ agentStatus: "paused", interruptedWhileWorking: true })).toBe("paused");
    expect(resolveResumeAgentStatus({ agentStatus: "asking", interruptedWhileWorking: true })).toBe("asking");
  });

  it("returns idle for every other worker — never the one-time ready", async () => {
    const { resolveResumeAgentStatus } = await importRegistry();
    // The bug this fixes: a resumed idle/done worker must not surface as "ready".
    expect(resolveResumeAgentStatus({ agentStatus: "idle" })).toBe("idle");
    expect(resolveResumeAgentStatus({ agentStatus: "exited" })).toBe("idle");
    expect(resolveResumeAgentStatus({ agentStatus: "loading" })).toBe("idle");
    expect(resolveResumeAgentStatus({})).toBe("idle");
  });
});

describe("createdAt backfill on read", () => {
  function writeEntry(REGISTRY_FILE: string, entry: Record<string, unknown>): void {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ workers: { proj: [{ name: "w", sessionId: "s", task: "", ...entry }] } }));
  }

  it("backfills createdAt from lastEventAt when present", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    writeEntry(REGISTRY_FILE, { lastEventAt: 4242 });
    expect(readRegistry().workers.proj[0].createdAt).toBe(4242);
  });

  it("backfills from mergedAt (ISO) when lastEventAt is absent", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    const iso = "2026-01-02T03:04:05.000Z";
    writeEntry(REGISTRY_FILE, { mergedAt: iso });
    expect(readRegistry().workers.proj[0].createdAt).toBe(Date.parse(iso));
  });

  it("backfills from lastShaChangeAt (ISO) when earlier sources are absent", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    const iso = "2026-02-03T04:05:06.000Z";
    writeEntry(REGISTRY_FILE, { lastShaChangeAt: iso });
    expect(readRegistry().workers.proj[0].createdAt).toBe(Date.parse(iso));
  });

  it("backfills from the legacy lastHookAt timestamp (via the status migration)", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    writeEntry(REGISTRY_FILE, { lastHookAt: 31337 });
    expect(readRegistry().workers.proj[0].createdAt).toBe(31337);
  });

  it("falls back to 0 for an entry with no usable timestamp", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    writeEntry(REGISTRY_FILE, {});
    expect(readRegistry().workers.proj[0].createdAt).toBe(0);
  });

  it("leaves an existing createdAt untouched", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    writeEntry(REGISTRY_FILE, { createdAt: 7, lastEventAt: 999 });
    expect(readRegistry().workers.proj[0].createdAt).toBe(7);
  });

  it("backfills lastStateChangeAt from lastEventAt so order is unchanged at upgrade", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    writeEntry(REGISTRY_FILE, { lastEventAt: 4242 });
    expect(readRegistry().workers.proj[0].lastStateChangeAt).toBe(4242);
  });

  it("backfills lastStateChangeAt from createdAt when lastEventAt is absent", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    writeEntry(REGISTRY_FILE, { createdAt: 77 });
    expect(readRegistry().workers.proj[0].lastStateChangeAt).toBe(77);
  });

  it("leaves an existing lastStateChangeAt untouched", async () => {
    const { readRegistry, REGISTRY_FILE } = await importRegistry();
    writeEntry(REGISTRY_FILE, { lastStateChangeAt: 5, lastEventAt: 999 });
    expect(readRegistry().workers.proj[0].lastStateChangeAt).toBe(5);
  });
});
