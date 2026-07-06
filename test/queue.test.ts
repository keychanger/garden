import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";
import type { WorkerEntry, WorkerRegistry } from "../src/dashboard/registry.js";

const h = vi.hoisted(() => ({
  isTTY: true,
  registry: { workers: {} } as WorkerRegistry,
  // null = every queried name is a known project; a list restricts which names
  // getProject accepts (others throw, mirroring the real getProject).
  known: null as string[] | null,
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  get isTTY() { return h.isTTY; },
}));
vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: () => h.registry,
}));
vi.mock("../src/config.js", () => ({
  getProject: (name: string) => {
    if (h.known && !h.known.includes(name)) {
      throw new Error(`Unknown project: ${name}. Run 'garden list' to see projects.`);
    }
    return { name };
  },
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
  h.known = null;
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
    // earlier is position 1 (next), later is 2. No /s flag: `← next` must sit on
    // the position-1 line, so a marker mis-placed on row 2 would fail the match
    // (with /s, `.*` crosses the newline and the check passes regardless).
    expect(text).toMatch(/1\.\s+earlier\s+merging.*← next/);
    expect(text).toMatch(/2\.\s+later\s+merging/);
    expect(text).not.toMatch(/2\.\s+later\s+merging.*← next/);
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

  it("orders the pipeline: merge-pending, reviewing, resolving, then blocked", async () => {
    h.registry = { workers: { p: [
      w("blocked", { prState: "failing", failingReason: "code" }),
      w("resolvingw", { prState: "resolving" }),
      w("reviewing1", { prState: "reviewing" }),
      w("queued", { prState: "merge-pending", mergePendingAt: "2026-01-01T00:01:00Z" }),
    ] } };
    const text = (await captureConsoleLog(() => queue([]))).map(strip);
    const body = text.filter(l => /queued|reviewing1|resolvingw|blocked/.test(l));
    expect(body[0]).toContain("queued");
    expect(body[1]).toContain("reviewing1");
    expect(body[2]).toContain("resolvingw");
    expect(body[3]).toContain("blocked");
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

  it("errors on an unknown project name instead of reporting an empty pipeline", async () => {
    h.known = ["real"];
    h.registry = { workers: { real: [w("rx", { prState: "reviewing" })] } };
    // A typo must throw (cli.ts renders it as "Error: Unknown project: …"),
    // not silently print the same empty-pipeline line a real project would.
    await expect(queue(["reel"])).rejects.toThrow(/Unknown project: reel/);
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
