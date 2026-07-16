// The spawn-composer draft: write/merge, one-shot consume, staleness, sweep.
// SESSIONS_DIR is redirected to a temp dir so real files are exercised.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const TMP = vi.hoisted(() => `${process.env.TMPDIR || "/tmp"}/garden-spawn-draft-${process.pid}`);
vi.mock("../src/config.js", () => ({ SESSIONS_DIR: TMP }));
vi.mock("../src/dashboard/log.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const { readSpawnDraft, writeSpawnDraft, consumeSpawnDraft, sweepSpawnDrafts, SPAWN_DRAFT_MAX_AGE_MS } =
  await import("../src/dashboard/spawn-draft.js");

const draftFile = (project: string) => path.join(TMP, `spawn-draft-${project}.json`);

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("spawn draft", () => {
  it("writes and reads back a base/crew override", () => {
    writeSpawnDraft("lex", { base: "v2-api" });
    expect(readSpawnDraft("lex")).toEqual({ base: "v2-api" });
  });

  it("merges successive patches (base then crew), preserving both", () => {
    writeSpawnDraft("lex", { base: "v2-api" });
    writeSpawnDraft("lex", { crew: "all-codex" });
    expect(readSpawnDraft("lex")).toEqual({ base: "v2-api", crew: "all-codex" });
  });

  it("an empty-string value clears that field", () => {
    writeSpawnDraft("lex", { base: "v2-api", crew: "all-codex" });
    writeSpawnDraft("lex", { base: "" });
    expect(readSpawnDraft("lex")).toEqual({ crew: "all-codex" });
  });

  it("consume returns the draft AND deletes it (one-shot)", () => {
    writeSpawnDraft("lex", { base: "v2-api" });
    expect(consumeSpawnDraft("lex")).toEqual({ base: "v2-api" });
    expect(readSpawnDraft("lex")).toEqual({});
    expect(fs.existsSync(draftFile("lex"))).toBe(false);
  });

  it("returns {} for an absent draft", () => {
    expect(readSpawnDraft("nope")).toEqual({});
    expect(consumeSpawnDraft("nope")).toEqual({});
  });

  it("ignores a stale draft (older than the max age)", () => {
    const stale = { base: "old", ts: Date.now() - SPAWN_DRAFT_MAX_AGE_MS - 1000 };
    fs.writeFileSync(draftFile("lex"), JSON.stringify(stale));
    expect(readSpawnDraft("lex")).toEqual({});
  });

  it("sweeps stale draft files, keeping fresh ones", () => {
    writeSpawnDraft("fresh", { base: "keep" });
    const staleFile = draftFile("stale");
    fs.writeFileSync(staleFile, JSON.stringify({ base: "gone", ts: 1 }));
    // Backdate the stale file's mtime past the cutoff.
    const old = Date.now() - SPAWN_DRAFT_MAX_AGE_MS - 60_000;
    fs.utimesSync(staleFile, old / 1000, old / 1000);

    const removed = sweepSpawnDrafts(Date.now());
    expect(removed).toBe(1);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(draftFile("fresh"))).toBe(true);
  });
});
