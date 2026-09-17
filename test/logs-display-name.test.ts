import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
  },
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    SESSIONS_DIR: "/tmp/fake-sessions",
    projectDisplayName: actual.projectDisplayName,
    logColorKeyForProject: () => null,
    loadConfig: () => ({
      projects: {
        wolf: { path: "/code/wolf", displayName: "Wolf Pack" },
        omi: { path: "/code/omi" },
      },
    }),
  };
});

vi.mock("../src/output.js", () => ({
  isTTY: false,
}));

import { formatPrettyEntry, type LogEntry } from "../src/commands/logs.js";

function entryFor(project: string): LogEntry {
  return {
    ts: "2026-09-17T12:00:00.000Z",
    level: "info",
    src: "poller",
    msg: "poller started",
    data: { project },
  };
}

describe("formatPrettyEntry project column", () => {
  it("shows the configured displayName instead of the project key", () => {
    const line = formatPrettyEntry(entryFor("wolf"), false);
    expect(line).toContain("Wolf Pack");
    expect(line).not.toMatch(/\bwolf\b/);
  });

  it("falls back to the project key when no displayName is set", () => {
    expect(formatPrettyEntry(entryFor("omi"), false)).toContain("omi");
  });

  it("falls back to the project key for a project missing from config", () => {
    expect(formatPrettyEntry(entryFor("ghost"), false)).toContain("ghost");
  });
});
