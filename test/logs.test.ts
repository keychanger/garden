import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0 })),
    openSync: vi.fn(() => 3),
    readSync: vi.fn(),
    closeSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock("../src/config.js", () => ({
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/output.js", () => ({
  isTTY: false,
}));

import {
  parseArgs,
  matchesFilters,
  dedup,
  relativeTime,
  type LogEntry,
  type Filters,
} from "../src/commands/logs.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseArgs", () => {
  it("returns defaults with no arguments", () => {
    const f = parseArgs([]);
    expect(f).toEqual({ count: 40, follow: false });
  });

  it("parses --follow / -f", () => {
    expect(parseArgs(["--follow"]).follow).toBe(true);
    expect(parseArgs(["-f"]).follow).toBe(true);
  });

  it("parses --level / -l", () => {
    expect(parseArgs(["--level", "warn"]).level).toBe("warn");
    expect(parseArgs(["-l", "ERROR"]).level).toBe("error");
  });

  it("parses --src / -s", () => {
    expect(parseArgs(["--src", "poller"]).src).toBe("poller");
    expect(parseArgs(["-s", "Poller"]).src).toBe("poller");
  });

  it("parses --worker / -w", () => {
    expect(parseArgs(["--worker", "bold-ash"]).worker).toBe("bold-ash");
    expect(parseArgs(["-w", "Bold-Ash"]).worker).toBe("bold-ash");
  });

  it("parses --count / -n", () => {
    expect(parseArgs(["--count", "100"]).count).toBe(100);
    expect(parseArgs(["-n", "10"]).count).toBe(10);
  });

  it("parses combined flags", () => {
    const f = parseArgs(["-f", "-l", "warn", "-s", "poller", "-n", "20"]);
    expect(f.follow).toBe(true);
    expect(f.level).toBe("warn");
    expect(f.src).toBe("poller");
    expect(f.count).toBe(20);
  });

  it("ignores flags without values", () => {
    const f = parseArgs(["--level"]);
    expect(f.level).toBeUndefined();
  });
});

describe("matchesFilters", () => {
  const entry: LogEntry = {
    ts: "2026-03-31T12:00:00Z",
    level: "info",
    src: "poller",
    msg: "checking workers",
    data: { worker: "bold-ash" },
  };

  it("matches with no filters", () => {
    expect(matchesFilters(entry, { count: 40, follow: false })).toBe(true);
  });

  it("filters by minimum level", () => {
    expect(matchesFilters(entry, { level: "info", count: 40, follow: false })).toBe(true);
    expect(matchesFilters(entry, { level: "warn", count: 40, follow: false })).toBe(false);
    expect(matchesFilters(entry, { level: "debug", count: 40, follow: false })).toBe(true);
  });

  it("filters by source", () => {
    expect(matchesFilters(entry, { src: "poller", count: 40, follow: false })).toBe(true);
    expect(matchesFilters(entry, { src: "review", count: 40, follow: false })).toBe(false);
  });

  it("filters by worker name in data.worker", () => {
    expect(matchesFilters(entry, { worker: "bold", count: 40, follow: false })).toBe(true);
    expect(matchesFilters(entry, { worker: "swift", count: 40, follow: false })).toBe(false);
  });

  it("matches worker in data.branchName", () => {
    const e: LogEntry = { ...entry, data: { branchName: "swift-oak" } };
    expect(matchesFilters(e, { worker: "swift", count: 40, follow: false })).toBe(true);
  });

  it("matches worker in data.windowName", () => {
    const e: LogEntry = { ...entry, data: { windowName: "_proj-worker-swift-oak" } };
    expect(matchesFilters(e, { worker: "swift", count: 40, follow: false })).toBe(true);
  });

  it("rejects when no worker field in data", () => {
    const e: LogEntry = { ...entry, data: { other: "val" } };
    expect(matchesFilters(e, { worker: "bold", count: 40, follow: false })).toBe(false);
  });

  it("rejects when data is undefined and worker filter set", () => {
    const e: LogEntry = { ts: entry.ts, level: "info", src: "poller", msg: "test" };
    expect(matchesFilters(e, { worker: "bold", count: 40, follow: false })).toBe(false);
  });
});

describe("dedup", () => {
  const makeEntry = (msg: string, level = "info"): LogEntry => ({
    ts: "2026-03-31T12:00:00Z",
    level,
    src: "poller",
    msg,
  });

  it("returns empty for empty input", () => {
    expect(dedup([])).toEqual([]);
  });

  it("passes through unique entries", () => {
    const entries = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const result = dedup(entries);
    expect(result).toHaveLength(3);
    expect(result.every((d) => d.count === 1)).toBe(true);
  });

  it("collapses consecutive identical entries", () => {
    const entries = [makeEntry("a"), makeEntry("a"), makeEntry("a")];
    const result = dedup(entries);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(3);
  });

  it("keeps latest timestamp for collapsed entries", () => {
    const e1: LogEntry = { ts: "2026-03-31T12:00:00Z", level: "info", src: "p", msg: "x" };
    const e2: LogEntry = { ts: "2026-03-31T12:01:00Z", level: "info", src: "p", msg: "x" };
    const result = dedup([e1, e2]);
    expect(result).toHaveLength(1);
    expect(result[0].entry.ts).toBe("2026-03-31T12:01:00Z");
  });

  it("does not collapse non-consecutive identical entries", () => {
    const entries = [makeEntry("a"), makeEntry("b"), makeEntry("a")];
    const result = dedup(entries);
    expect(result).toHaveLength(3);
  });

  it("treats different levels as different entries", () => {
    const entries = [makeEntry("a", "info"), makeEntry("a", "warn")];
    const result = dedup(entries);
    expect(result).toHaveLength(2);
  });
});

describe("relativeTime", () => {
  it("returns seconds for recent timestamps", () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(ts)).toBe("30s ago");
  });

  it("returns minutes for timestamps within an hour", () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(ts)).toBe("5m ago");
  });

  it("returns hours for timestamps within a day", () => {
    const ts = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(relativeTime(ts)).toBe("3h ago");
  });

  it("returns absolute date for old timestamps", () => {
    const ts = new Date(Date.now() - 48 * 3600_000).toISOString();
    const result = relativeTime(ts);
    expect(result).not.toContain("ago");
  });

  it("returns 'just now' for future timestamps", () => {
    const ts = new Date(Date.now() + 10_000).toISOString();
    expect(relativeTime(ts)).toBe("just now");
  });
});
