import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";
import type { WorkerEntry, WorkerRegistry } from "../src/dashboard/registry.js";

const h = vi.hoisted(() => ({ isTTY: true, registry: { workers: {} } as WorkerRegistry }));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  get isTTY() { return h.isTTY; },
}));
vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: () => h.registry,
}));

import { queue } from "../src/commands/queue.js";
import { output } from "../src/output.js";

function w(name: string, e: Partial<WorkerEntry>): WorkerEntry {
  return { name, sessionId: "s", task: "", ...e };
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

beforeEach(() => {
  h.isTTY = true;
  h.registry = { workers: {} };
  vi.clearAllMocks();
});

describe("garden queue", () => {
  it("reports an empty pipeline", async () => {
    const lines = (await captureConsoleLog(() => queue([]))).map(strip);
    expect(lines.some(l => l.includes("Merge pipeline is empty"))).toBe(true);
  });

  it("excludes non-pipeline workers (working / idle / merged)", async () => {
    h.registry = { workers: { p: [
      w("busy", { prState: undefined, agentStatus: "working" }),
      w("done-one", { prState: "merged" }),
    ] } };
    const lines = (await captureConsoleLog(() => queue([]))).map(strip);
    expect(lines.join("\n")).toContain("Merge pipeline is empty");
  });

  it("numbers the merge queue by mergePendingAt (earliest merges next)", async () => {
    h.registry = { workers: { p: [
      w("later", { prState: "merge-pending", mergePendingAt: "2026-01-01T00:05:00Z" }),
      w("earlier", { prState: "merge-pending", mergePendingAt: "2026-01-01T00:01:00Z" }),
    ] } };
    const text = (await captureConsoleLog(() => queue([]))).map(strip).join("\n");
    // earlier is position 1 (next), later is 2.
    expect(text).toMatch(/1\.\s+earlier\s+merging.*← next/s);
    expect(text).toMatch(/2\.\s+later\s+merging/);
  });

  it("shows CI markers for ci-fixing and failing-ci rows", async () => {
    h.registry = { workers: { p: [
      w("fixing", { prState: "ci-fixing", ciFixAttempts: 2 }),
      w("broke", { prState: "failing", failingReason: "ci", failingSha: "abc1234def" }),
    ] } };
    const text = (await captureConsoleLog(() => queue([]))).map(strip).join("\n");
    expect(text).toContain("CI fix 2/3");
    expect(text).toContain("CI ✗ abc1234");
  });

  it("orders the pipeline: merge-pending, then in-review, then blocked", async () => {
    h.registry = { workers: { p: [
      w("blocked", { prState: "failing", failingReason: "code" }),
      w("reviewing1", { prState: "reviewing" }),
      w("queued", { prState: "merge-pending", mergePendingAt: "2026-01-01T00:01:00Z" }),
    ] } };
    const text = (await captureConsoleLog(() => queue([]))).map(strip);
    const body = text.filter(l => /queued|reviewing1|blocked/.test(l));
    expect(body[0]).toContain("queued");
    expect(body[1]).toContain("reviewing1");
    expect(body[2]).toContain("blocked");
  });

  it("filters to a single project when named", async () => {
    h.registry = { workers: {
      a: [w("ax", { prState: "reviewing" })],
      b: [w("bx", { prState: "reviewing" })],
    } };
    const text = (await captureConsoleLog(() => queue(["a"]))).map(strip).join("\n");
    expect(text).toContain("ax");
    expect(text).not.toContain("bx");
  });

  it("emits JSON when not a TTY", async () => {
    h.isTTY = false;
    h.registry = { workers: { p: [w("qx", { prState: "merge-pending", mergePendingAt: "2026-01-01T00:01:00Z" })] } };
    await queue([]);
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      projects: expect.arrayContaining([
        expect.objectContaining({ name: "p", rows: expect.arrayContaining([
          expect.objectContaining({ worker: "qx", queuePos: 1 }),
        ]) }),
      ]),
    }));
  });
});
