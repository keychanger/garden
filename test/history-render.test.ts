// writeHistoryRendered bakes the ⌥h view on every dashboard refresh while that
// view is open, so on every state-changing hook the fleet fires. Re-reading the
// focused worker's transcript for each one (a 16MB tail read, escalating) is
// wasted when nothing the bake depends on has moved. These run the real bake
// against a real transcript (header.test.ts mocks node:fs wholesale) and count
// how often the transcript is opened, resetting the in-process caches between
// bakes as each hook's fresh process would.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

vi.mock("../src/dashboard/tmux.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dashboard/tmux.js")>()),
  getPaneSize: vi.fn(() => ({ width: 80, height: 40 })),
  getPanePid: vi.fn(() => null),
}));
vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const env = useTmpHome();

const line = (role: "user" | "assistant", content: unknown, ts: string) =>
  JSON.stringify({ type: role, message: { role, content }, timestamp: ts, isSidechain: false }) + "\n";

async function historyView() {
  const header = await import("../src/dashboard/header.js");
  const tmux = await import("../src/dashboard/tmux.js");
  const { SESSIONS_DIR } = await import("../src/config.js");
  const transcript = path.join(env.home, "transcript.jsonl");
  fs.writeFileSync(transcript,
    line("user", "fix the auth bug", "2026-10-23T10:00:00Z")
    + line("assistant", [{ type: "text", text: "Fixed it." }], "2026-10-23T10:00:05Z"));
  const entry = { name: "bold-ash", sessionId: "s1", agentStatus: "idle" as string, transcriptPath: transcript };
  const opts = {
    state: {
      activeProject: "garden", activePaneType: "worker", activeWindowName: "_garden-worker-bold-ash",
      gardenPaneType: "history", gardenShellPaneId: "%3",
    } as never,
    registry: { workers: { garden: [entry] } } as never,
  };
  const opened = vi.spyOn(fs, "openSync");
  // One bake in a fresh process; returns how many times it opened the transcript.
  const bake = (): number => {
    header._resetHeaderCachesForTest();
    opened.mockClear();
    header.writeHistoryRendered(opts);
    return opened.mock.calls.filter(c => c[0] === transcript).length;
  };
  const renderedFile = path.join(SESSIONS_DIR, "history.rendered");
  return { tmux, transcript, entry, bake, rendered: () => fs.readFileSync(renderedFile, "utf8"), renderedFile };
}

describe("writeHistoryRendered transcript reads", () => {
  it("re-reads the transcript only when it, the pane width or the worker's status changed", async () => {
    const v = await historyView();
    expect(v.bake()).toBe(1);
    expect(v.rendered()).toContain("fix the auth bug");
    expect(v.bake()).toBe(0);

    fs.appendFileSync(v.transcript, line("user", "now add a test", "2026-10-23T10:01:00Z"));
    expect(v.bake()).toBe(1);
    expect(v.rendered()).toContain("now add a test");
    expect(v.bake()).toBe(0);

    vi.mocked(v.tmux.getPaneSize).mockReturnValue({ width: 100, height: 40 });
    expect(v.bake()).toBe(1);
    v.entry.agentStatus = "working";
    expect(v.bake()).toBe(1);
    expect(v.rendered()).toContain("working…");
    expect(v.bake()).toBe(0);
  });

  it("re-reads when history.rendered no longer holds the bake the key was stored with", async () => {
    const v = await historyView();
    expect(v.bake()).toBe(1);
    const baked = v.rendered();
    // Another process's bake, or a placeholder written while focus was elsewhere.
    fs.writeFileSync(v.renderedFile, " no active worker");
    expect(v.bake()).toBe(1);
    expect(v.rendered()).toBe(baked);
  });
});
