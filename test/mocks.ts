// Shared mock factories for vi.mock(). Narrow scope by design: only patterns
// that 3+ test files duplicate identically belong here. Variant mocks
// (different export subsets, custom return values) stay inline in the test
// where they live, because that's where the test's contract is most readable.
//
// Usage:
//   import { logMockModule } from "./mocks.js";
//   vi.mock("../src/dashboard/log.js", logMockModule);
//
// vi.mock hoists above imports, but the factory function is evaluated lazily
// when the mocked module is first loaded — by then top-level imports have run,
// so referencing factories from this file is safe.

import { vi } from "vitest";
import type { WorkerEntry } from "../src/dashboard/registry.js";

export function logMockModule() {
  return {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

export function refreshDashboardMockModule() {
  return {
    refreshDashboard: vi.fn(),
  };
}

export interface RegistryMockHandle {
  setEntries(project: string, list: WorkerEntry[]): void;
  clear(): void;
}

// Factory for an in-memory registry mock. The returned module exposes the
// real registry surface plus _handle for tests to drive state. Used like:
//   vi.mock("../src/dashboard/registry.js", registryMockModule);
//   const reg = await import("../src/dashboard/registry.js") as
//     typeof import("../src/dashboard/registry.js") & { _handle: RegistryMockHandle };
//   reg._handle.setEntries("proj", [makeWorker(...)]);
export function registryMockModule() {
  const entries: Record<string, WorkerEntry[]> = {};
  const handle: RegistryMockHandle = {
    setEntries(project, list) { entries[project] = list; },
    clear() { for (const key of Object.keys(entries)) delete entries[key]; },
  };
  return {
    readRegistry: vi.fn(() => ({ workers: entries })),
    getWorkers: vi.fn((project: string) => entries[project] ?? []),
    updateWorkerFields: vi.fn(
      (project: string, name: string, fields: Record<string, unknown>) => {
        const list = entries[project];
        if (!list) return;
        const entry = list.find(e => e.name === name);
        if (entry) Object.assign(entry, fields);
      },
    ),
    findWorkerByName: vi.fn(
      (project: string, name: string) => entries[project]?.find(e => e.name === name),
    ),
    _handle: handle,
  };
}
