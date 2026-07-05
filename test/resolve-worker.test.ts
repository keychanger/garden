import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    readRegistry: () => ({ workers: entries }),
    _setEntries: (p: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[p] = list;
    },
    _clear: () => { for (const k of Object.keys(entries)) delete entries[k]; },
  };
});

vi.mock("../src/dashboard/state.js", () => {
  let active: string | null = null;
  return {
    readDashState: () => ({ activeWindowName: active }),
    _setActive: (w: string | null) => { active = w; },
  };
});

vi.mock("../src/dashboard/window-names.js", () => ({
  parseWorkerWindow: (name: string) => {
    const m = name.match(/^_(.+)-worker-(.+)$/);
    return m ? { project: m[1], worker: m[2] } : null;
  },
}));

import { resolveWorkerArg } from "../src/commands/resolve-worker.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const reg = await import("../src/dashboard/registry.js") as unknown as {
  _setEntries: (p: string, list: WorkerEntry[]) => void;
  _clear: () => void;
};
const st = await import("../src/dashboard/state.js") as unknown as {
  _setActive: (w: string | null) => void;
};

function w(name: string): WorkerEntry {
  return { name, sessionId: "s", task: "" };
}

beforeEach(() => {
  reg._clear();
  st._setActive(null);
});

describe("resolveWorkerArg", () => {
  it("throws when no workers exist at all", () => {
    expect(() => resolveWorkerArg("x")).toThrow(/No workers exist/);
  });

  it("resolves an exact name", () => {
    reg._setEntries("p", [w("bold-ash"), w("calm-elm")]);
    expect(resolveWorkerArg("bold-ash").worker).toBe("bold-ash");
  });

  it("resolves a unique prefix, case-insensitively", () => {
    reg._setEntries("p", [w("bleak-hoar-glow"), w("calm-elm")]);
    expect(resolveWorkerArg("blea").worker).toBe("bleak-hoar-glow");
    expect(resolveWorkerArg("BLEAK-H").worker).toBe("bleak-hoar-glow");
  });

  it("resolves a unique substring when no prefix matches", () => {
    reg._setEntries("p", [w("bleak-hoar-glow"), w("calm-elm")]);
    expect(resolveWorkerArg("hoar").worker).toBe("bleak-hoar-glow");
  });

  it("prefers an exact match over being a prefix of a longer name", () => {
    reg._setEntries("p", [w("foo"), w("foobar")]);
    expect(resolveWorkerArg("foo").worker).toBe("foo");
  });

  it("is ambiguous when a prefix matches several", () => {
    reg._setEntries("p", [w("bold-ash"), w("bold-elm")]);
    expect(() => resolveWorkerArg("bold")).toThrow(/matches multiple workers/);
  });

  it("is ambiguous when the same name exists in two projects", () => {
    reg._setEntries("a", [w("shared")]);
    reg._setEntries("b", [w("shared")]);
    expect(() => resolveWorkerArg("shared")).toThrow(/matches multiple workers/);
  });

  it("reports no match and lists known workers", () => {
    reg._setEntries("p", [w("bold-ash")]);
    expect(() => resolveWorkerArg("ghost")).toThrow(/No worker matches 'ghost'.*bold-ash/s);
  });

  it("resolves '.' to the focused worker", () => {
    reg._setEntries("p", [w("bold-ash"), w("calm-elm")]);
    st._setActive("_p-worker-calm-elm");
    expect(resolveWorkerArg(".").worker).toBe("calm-elm");
  });

  it("throws for '.' when no worker pane is focused", () => {
    reg._setEntries("p", [w("bold-ash")]);
    st._setActive("_garden-root");
    expect(() => resolveWorkerArg(".")).toThrow(/no worker pane is focused/);
  });
});
