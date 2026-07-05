import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

const env = useTmpHome();

function seedRegistry(workers: Record<string, Array<{
  name: string; sessionId?: string; task?: string; worktreePath?: string;
}>>) {
  fs.writeFileSync(
    path.join(env.sessionsDir, "dashboard.registry.json"),
    JSON.stringify({ workers: Object.fromEntries(
      Object.entries(workers).map(([p, ws]) => [p, ws.map(w => ({
        name: w.name, sessionId: w.sessionId ?? "s", task: w.task ?? "",
        ...(w.worktreePath ? { worktreePath: w.worktreePath } : {}),
      }))]),
    ) }),
  );
}

function makeWorktree(project: string, worker: string): string {
  const wt = path.join(env.home, ".garden", "worktrees", project, worker);
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

describe("garden pause", () => {
  it("throws when called without a worker name", async () => {
    const { pause } = await import("../src/commands/pause.js");
    await expect(pause([])).rejects.toThrow("Usage: garden pause <worker>");
  });

  it("throws when no worker matches the name", async () => {
    seedRegistry({ proj: [{ name: "alpha", worktreePath: makeWorktree("proj", "alpha") }] });
    const { pause } = await import("../src/commands/pause.js");
    await expect(pause(["ghost"])).rejects.toThrow("No worker matches 'ghost'");
  });

  it("throws when the name is ambiguous across projects", async () => {
    seedRegistry({
      a: [{ name: "shared", worktreePath: makeWorktree("a", "shared") }],
      b: [{ name: "shared", worktreePath: makeWorktree("b", "shared") }],
    });
    const { pause } = await import("../src/commands/pause.js");
    await expect(pause(["shared"])).rejects.toThrow(/'shared' matches multiple workers/);
  });

  it("throws when the matched worker has no worktreePath (legacy entry)", async () => {
    seedRegistry({ proj: [{ name: "legacy" }] });
    const { pause } = await import("../src/commands/pause.js");
    await expect(pause(["legacy"])).rejects.toThrow(/has no worktreePath/);
  });

  it("writes the .garden-done sentinel at the worker's worktree root", async () => {
    const wt = makeWorktree("proj", "alpha");
    seedRegistry({ proj: [{ name: "alpha", worktreePath: wt }] });
    const { pause } = await import("../src/commands/pause.js");
    await captureConsoleLog(() => pause(["alpha"]));
    expect(fs.existsSync(path.join(wt, ".garden-done"))).toBe(true);
  });

  it("is idempotent (writing twice is fine)", async () => {
    const wt = makeWorktree("proj", "alpha");
    seedRegistry({ proj: [{ name: "alpha", worktreePath: wt }] });
    const { pause } = await import("../src/commands/pause.js");
    await captureConsoleLog(() => pause(["alpha"]));
    await captureConsoleLog(() => pause(["alpha"]));
    expect(fs.existsSync(path.join(wt, ".garden-done"))).toBe(true);
  });
});

describe("garden resume", () => {
  it("throws when called without a worker name", async () => {
    const { resume } = await import("../src/commands/resume.js");
    await expect(resume([])).rejects.toThrow("Usage: garden resume <worker>");
  });

  it("throws when no worker matches", async () => {
    seedRegistry({ proj: [{ name: "alpha", worktreePath: makeWorktree("proj", "alpha") }] });
    const { resume } = await import("../src/commands/resume.js");
    await expect(resume(["ghost"])).rejects.toThrow(/No worker matches/);
  });

  it("deletes the sentinel and reports resumed when sentinel was present", async () => {
    const wt = makeWorktree("proj", "alpha");
    seedRegistry({ proj: [{ name: "alpha", worktreePath: wt }] });
    fs.writeFileSync(path.join(wt, ".garden-done"), "");
    const { resume } = await import("../src/commands/resume.js");
    const out = await captureConsoleLog(() => resume(["alpha"]));
    expect(fs.existsSync(path.join(wt, ".garden-done"))).toBe(false);
    expect(out.join("\n")).toContain("Resumed");
  });

  it("reports 'was not paused' when sentinel was absent (no error)", async () => {
    const wt = makeWorktree("proj", "alpha");
    seedRegistry({ proj: [{ name: "alpha", worktreePath: wt }] });
    const { resume } = await import("../src/commands/resume.js");
    const out = await captureConsoleLog(() => resume(["alpha"]));
    expect(out.join("\n")).toContain("was not paused");
  });

  it("ambiguous name produces the same error shape as pause", async () => {
    seedRegistry({
      a: [{ name: "shared", worktreePath: makeWorktree("a", "shared") }],
      b: [{ name: "shared", worktreePath: makeWorktree("b", "shared") }],
    });
    const { resume } = await import("../src/commands/resume.js");
    await expect(resume(["shared"])).rejects.toThrow(/'shared' matches multiple workers/);
  });
});
