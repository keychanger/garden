import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const h = vi.hoisted(() => ({
  isTTY: true,
  resolved: null as { project: string; worker: string; entry: WorkerEntry } | null,
  pagerError: undefined as Error | undefined,
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  get isTTY() { return h.isTTY; },
}));

vi.mock("../src/commands/resolve-worker.js", () => ({
  resolveWorkerArg: vi.fn(() => {
    if (!h.resolved) throw new Error("No worker matches 'x'.");
    return h.resolved;
  }),
}));

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({ error: h.pagerError })),
}));

import { history } from "../src/commands/history.js";
import { output } from "../src/output.js";
import { resolveWorkerArg } from "../src/commands/resolve-worker.js";
import { spawnSync } from "node:child_process";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function setWorker(lines: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-history-"));
  const transcriptPath = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcriptPath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  h.resolved = {
    project: "garden",
    worker: "bold-ash",
    entry: { name: "bold-ash", sessionId: "s1", task: "", transcriptPath },
  };
  return transcriptPath;
}

const user = (content: string, ts: string) => ({ type: "user", message: { role: "user", content }, timestamp: ts });
const said = (text: string, ts: string) =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: ts });

beforeEach(() => {
  h.isTTY = true;
  h.pagerError = undefined;
  vi.clearAllMocks();
});

describe("garden history", () => {
  it("pages the whole conversation from the opening prompt, with each closing reply", async () => {
    setWorker([
      user("first ask", "2026-11-19T17:00:00Z"),
      said("Answer one.", "2026-11-19T17:00:05Z"),
      user("second ask", "2026-11-19T18:00:00Z"),
      said("Answer two.", "2026-11-19T18:00:05Z"),
    ]);
    await history([]);

    expect(resolveWorkerArg).toHaveBeenCalledWith(".");
    const [cmd, args, opts] = vi.mocked(spawnSync).mock.calls[0] as unknown as [string, string[], { input: string }];
    expect(cmd).toBe("less");
    expect(args).toContain("-R");
    const text = strip(opts.input);
    expect(text).toContain("garden/bold-ash  2 prompts");
    expect(text.indexOf("first ask")).toBeLessThan(text.indexOf("Answer one."));
    expect(text.indexOf("Answer one.")).toBeLessThan(text.indexOf("second ask"));
    expect(text).toContain("Answer two.");
  });

  it("prints straight to the terminal when no pager is available", async () => {
    setWorker([user("only ask", "2026-11-19T17:00:00Z")]);
    h.pagerError = new Error("spawnSync less ENOENT");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await history(["bold-ash"]);
      expect(strip(String(write.mock.calls[0][0]))).toContain("only ask");
    } finally {
      write.mockRestore();
    }
  });

  it("emits the turns as JSON when piped", async () => {
    const transcriptPath = setWorker([user("piped ask", "2026-11-19T17:00:00Z"), said("Done.", "2026-11-19T17:00:05Z")]);
    h.isTTY = false;
    await history(["bold-ash"]);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith({
      project: "garden",
      worker: "bold-ash",
      transcriptPath,
      turns: [
        { role: "user", text: "piped ask", ts: "2026-11-19T17:00:00Z" },
        { role: "assistant", text: "Done.", verb: "answered", ts: "2026-11-19T17:00:05Z", reply: "Done." },
      ],
    });
  });
});
