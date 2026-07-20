// The crew composer's draft store and the save/delete runners it feeds. The
// draft is what lets a fire-and-forget tmux menu compose a multi-field crew
// across several re-opens.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
const { sessionsDir } = vi.hoisted(() => ({ sessionsDir: { value: "" } }));

vi.mock("../src/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/config.js")>();
  return { ...actual, get SESSIONS_DIR() { return sessionsDir.value; } };
});

// See crew-picker-mutate.test.ts: an unmocked logger writes into the repo root.
vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-crew-draft-"));
  sessionsDir.value = tmpDir;
});

const { readCrewDraft, writeCrewDraft, clearCrewDraft, seedCrewDraft, CREW_DRAFT_MAX_AGE_MS } =
  await import("../src/dashboard/crew-draft.js");

describe("crew draft", () => {
  it("merges patches across writes so each menu re-open adds one dimension", () => {
    writeCrewDraft({ worker: "claude" });
    writeCrewDraft({ workerModel: "opus" });
    writeCrewDraft({ review: "codex" });
    expect(readCrewDraft()).toEqual({ worker: "claude", workerModel: "opus", review: "codex" });
  });

  it("an empty-string value clears that field (the submenu 'clear' rows)", () => {
    writeCrewDraft({ worker: "claude", workerModel: "opus" });
    writeCrewDraft({ workerModel: "" });
    expect(readCrewDraft()).toEqual({ worker: "claude" });
  });

  it("ignores a stale draft rather than resurrecting last week's composition", () => {
    writeCrewDraft({ worker: "claude" });
    const file = path.join(tmpDir, "crew-draft.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    parsed.ts = Date.now() - CREW_DRAFT_MAX_AGE_MS - 1;
    fs.writeFileSync(file, JSON.stringify(parsed));
    expect(readCrewDraft()).toEqual({});
  });

  it("returns {} for a missing or corrupt file rather than throwing", () => {
    expect(readCrewDraft()).toEqual({});
    fs.writeFileSync(path.join(tmpDir, "crew-draft.json"), "{not json");
    expect(readCrewDraft()).toEqual({});
  });

  it("seeding replaces any prior draft and stamps the edited name", () => {
    writeCrewDraft({ worker: "codex", workerEffort: "low" });
    seedCrewDraft("heavy", { worker: "claude", workerModel: "opus", review: "claude" });
    expect(readCrewDraft()).toEqual({
      editing: "heavy", worker: "claude", workerModel: "opus", review: "claude",
    });
  });

  it("clear removes the draft", () => {
    writeCrewDraft({ worker: "claude" });
    clearCrewDraft();
    expect(readCrewDraft()).toEqual({});
  });
});
