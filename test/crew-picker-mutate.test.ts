// The ⌥⇧C composer's mutating dispatch: staging a dimension, saving a composed
// crew, and deleting one. The plan builders are pure and covered in
// crew.test.ts; this covers the runners that write config.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GardenConfig } from "../src/config.js";

let tmpDir: string;
const { store, sessionsDir, displayed } = vi.hoisted(() => ({
  store: { value: null as unknown as GardenConfig },
  sessionsDir: { value: "" },
  displayed: { lines: [] as string[] },
}));

vi.mock("../src/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/config.js")>();
  return {
    ...actual,
    get SESSIONS_DIR() { return sessionsDir.value; },
    loadConfig: () => store.value,
    saveConfig: (c: GardenConfig) => { store.value = c; },
    tryGetProject: (n: string) => (store.value.projects[n] ? { name: n, ...store.value.projects[n] } : null),
  };
});
// log.ts resolves its own file path (not SESSIONS_DIR), so an unmocked logger
// writes dashboard.log into the repo root on every test run.
vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));
vi.mock("../src/dashboard/menu.js", () => ({ runMenu: vi.fn(), buildMenuArgv: vi.fn(() => []) }));
vi.mock("../src/dashboard/state.js", () => ({ readDashState: () => ({ activeProject: "garden" }) }));
vi.mock("../src/dashboard/runner.js", () => ({ resolveGardenRunner: () => "/n /cli.js" }));
vi.mock("../src/dashboard/tmux.js", async (orig) => {
  const actual = await orig<typeof import("../src/dashboard/tmux.js")>();
  return { ...actual, tmuxDisplay: (m: string) => { displayed.lines.push(m); } };
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-crew-mutate-"));
  sessionsDir.value = tmpDir;
  store.value = { projects: { garden: { path: "/p" } } } as GardenConfig;
  displayed.lines = [];
});

const { setCrewDimFromPicker, saveCrewFromPicker, deleteCrewFromPicker, cancelCrewComposer,
  runStoredCrewPicker } =
  await import("../src/dashboard/crew-picker.js");
const { readCrewDraft, writeCrewDraft, seedCrewDraft } = await import("../src/dashboard/crew-draft.js");
const { getCrew, saveCrew, applyCrew } = await import("../src/dashboard/crew.js");

describe("composing and saving a crew from the menu", () => {
  it("stages each dimension into the draft under its crew-def field name", () => {
    setCrewDimFromPicker("garden", "worker", "codex");
    setCrewDimFromPicker("garden", "model", "opus");
    setCrewDimFromPicker("garden", "effort", "xhigh");
    setCrewDimFromPicker("garden", "reviewer", "claude");
    setCrewDimFromPicker("garden", "review-model", "sonnet");
    expect(readCrewDraft()).toEqual({
      worker: "codex", workerModel: "opus", workerEffort: "xhigh",
      review: "claude", reviewModel: "sonnet",
    });
  });

  it("saves the composed crew, then clears the draft", () => {
    writeCrewDraft({ worker: "claude", workerModel: "opus", workerEffort: "xhigh", review: "codex" });
    saveCrewFromPicker("garden", "heavy");
    expect(store.value.crews?.heavy).toEqual({
      worker: { member: "claude", model: "opus", effort: "xhigh" },
      review: { member: "codex" },
    });
    expect(readCrewDraft()).toEqual({});
  });

  it("refuses to save an incomplete draft or a blank name", () => {
    writeCrewDraft({ worker: "claude" });
    saveCrewFromPicker("garden", "half");
    expect(store.value.crews).toBeUndefined();
    expect(displayed.lines.join()).toMatch(/worker and a reviewer/);

    displayed.lines = [];
    writeCrewDraft({ review: "claude" });
    saveCrewFromPicker("garden", "   ");
    expect(store.value.crews).toBeUndefined();
    expect(displayed.lines.join()).toMatch(/name required/);
  });

  it("refuses to silently overwrite an existing crew when creating", () => {
    saveCrew("heavy", { worker: { member: "claude" }, review: { member: "claude" } });
    writeCrewDraft({ worker: "codex", review: "codex" });
    saveCrewFromPicker("garden", "heavy");
    expect(store.value.crews?.heavy.worker.member).toBe("claude");
    expect(displayed.lines.join()).toMatch(/already exists/);
  });

  it("but an edit saves over the name it was seeded with", () => {
    saveCrew("heavy", { worker: { member: "claude" }, review: { member: "claude" } });
    seedCrewDraft("heavy", { worker: "codex", review: "claude" });
    saveCrewFromPicker("garden", "heavy");
    expect(store.value.crews?.heavy.worker.member).toBe("codex");
  });

  it("surfaces a validation failure as a tmux message rather than throwing", () => {
    store.value.providers = { deepseek: { baseUrl: "x", authTokenEnv: "K" } } as GardenConfig["providers"];
    // The safety asymmetry: a provider may build but never review.
    writeCrewDraft({ worker: "claude", review: "deepseek" });
    expect(() => saveCrewFromPicker("garden", "bad")).not.toThrow();
    expect(store.value.crews).toBeUndefined();
    expect(displayed.lines.join()).toMatch(/cannot review/);
  });
});

describe("the edit/delete chooser with nothing stored", () => {
  // The picker offers edit/delete unconditionally, so this is the path an
  // operator with no crews yet actually lands on. It must explain the empty
  // state and point at the fix — a silent no-op here is exactly the
  // "feature looks broken" failure the unconditional rows were meant to end.
  it("explains the empty state instead of opening an empty menu", () => {
    for (const action of ["edit", "delete"]) {
      displayed.lines = [];
      runStoredCrewPicker("garden", action);
      expect(displayed.lines.join()).toMatch(/No crews defined yet — use 'new crew…' first\./);
    }
  });

  it("rejects an unknown action rather than silently doing nothing", () => {
    runStoredCrewPicker("garden", "frobnicate");
    expect(displayed.lines.join()).toMatch(/Unknown crew action 'frobnicate'/);
  });

  it("opens the chooser once a crew exists", () => {
    saveCrew("heavy", { worker: { member: "claude" }, review: { member: "claude" } });
    displayed.lines = [];
    runStoredCrewPicker("garden", "edit");
    expect(displayed.lines).toEqual([]);
  });
});

describe("deleting a crew from the menu", () => {
  it("removes it and names the projects left with a dangling reference", () => {
    saveCrew("heavy", { worker: { member: "claude" }, review: { member: "claude" } });
    applyCrew("garden", getCrew("heavy", store.value)!);
    deleteCrewFromPicker("garden", "heavy");
    expect(store.value.crews).toBeUndefined();
    expect(displayed.lines.join()).toMatch(/garden now resolve from their own keys/);
  });

  it("refuses a builtin without throwing", () => {
    expect(() => deleteCrewFromPicker("garden", "all-codex")).not.toThrow();
    expect(displayed.lines.join()).toMatch(/No stored crew 'all-codex'/);
  });
});

describe("cancelling", () => {
  it("discards the draft", () => {
    writeCrewDraft({ worker: "claude", review: "claude" });
    cancelCrewComposer("garden");
    expect(readCrewDraft()).toEqual({});
  });
});
