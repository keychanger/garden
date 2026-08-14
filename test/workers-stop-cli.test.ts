import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

// `garden workers stop <worker>` CLI surface: argument handling and the
// resolveWorkerArg wiring (prefix matching, ambiguity, unknown names). The
// removal mechanics themselves are covered in workers.test.ts against
// stopWorkerByName / finalizeWorkerRemoval.

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    readRegistry: () => ({ workers: entries }),
    findWorkerByName: (p: string, n: string) => entries[p]?.find(e => e.name === n),
    updateWorkerFields: vi.fn(),
    _setEntries: (p: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[p] = list;
    },
    _clear: () => { for (const k of Object.keys(entries)) delete entries[k]; },
  };
});

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: () => ({ activeWindowName: null }),
}));

vi.mock("../src/dashboard/workers.js", () => ({
  newWorker: vi.fn(() => "tall-fern"),
  stopWorkerByName: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { workers } from "../src/commands/workers.js";
import { stopWorkerByName } from "../src/dashboard/workers.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const reg = await import("../src/dashboard/registry.js") as unknown as {
  _setEntries: (p: string, list: WorkerEntry[]) => void;
  _clear: () => void;
};

function w(name: string): WorkerEntry {
  return { name, sessionId: "s", task: "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  reg._clear();
});

describe("garden workers stop", () => {
  it("requires a worker argument", async () => {
    reg._setEntries("p", [w("bold-ash")]);
    await expect(workers(["stop"])).rejects.toThrow(/Usage: garden workers stop <worker>/);
    expect(vi.mocked(stopWorkerByName)).not.toHaveBeenCalled();
  });

  it("rejects extra arguments instead of guessing which worker was meant", async () => {
    reg._setEntries("p", [w("bold-ash"), w("calm-elm")]);
    await expect(workers(["stop", "bold-ash", "calm-elm"]))
      .rejects.toThrow(/Unexpected extra arguments/);
    expect(vi.mocked(stopWorkerByName)).not.toHaveBeenCalled();
  });

  it("errors on an unknown worker, listing known workers", async () => {
    reg._setEntries("p", [w("bold-ash")]);
    await expect(workers(["stop", "ghost"]))
      .rejects.toThrow(/No worker matches 'ghost'.*bold-ash/s);
    expect(vi.mocked(stopWorkerByName)).not.toHaveBeenCalled();
  });

  it("errors on an ambiguous prefix, listing the candidates", async () => {
    reg._setEntries("p", [w("bold-ash"), w("bold-elm")]);
    await expect(workers(["stop", "bold"])).rejects.toThrow(/matches multiple workers/);
    expect(vi.mocked(stopWorkerByName)).not.toHaveBeenCalled();
  });

  it("resolves a unique prefix and stops that worker", async () => {
    reg._setEntries("p", [w("bleak-hoar-glow"), w("calm-elm")]);
    const lines = await captureConsoleLog(() => workers(["stop", "blea"]));
    expect(vi.mocked(stopWorkerByName)).toHaveBeenCalledWith("p", "bleak-hoar-glow");
    expect(lines.join("\n")).toContain("Stopped p/bleak-hoar-glow");
  });

  it("stops an exact-name match across projects", async () => {
    reg._setEntries("a", [w("bold-ash")]);
    reg._setEntries("b", [w("calm-elm")]);
    await captureConsoleLog(() => workers(["stop", "calm-elm"]));
    expect(vi.mocked(stopWorkerByName)).toHaveBeenCalledWith("b", "calm-elm");
  });
});
