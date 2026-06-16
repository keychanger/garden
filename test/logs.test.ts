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
  wrapDetail,
  renderDataValue,
  parseFilterExpr,
  applyStickyDefaults,
  formatLogsPaneLabel,
  resetWorkerMapCaches,
  type LogEntry,
  type Filters,
} from "../src/commands/logs.js";
import fs from "node:fs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("formatLogsPaneLabel", () => {
  it("returns plain 'logs' when no filter is set on disk (default arg)", () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(formatLogsPaneLabel()).toBe("logs");
  });

  it("returns plain 'logs' when explicitly passed null or empty string", () => {
    expect(formatLogsPaneLabel(null)).toBe("logs");
    expect(formatLogsPaneLabel("")).toBe("logs");
  });

  it("appends the filter expression after a dim style separator", () => {
    expect(formatLogsPaneLabel("worker:bold-ash")).toBe(
      "logs #[fg=colour244]· filter:#[default] worker:bold-ash",
    );
  });

  it("doubles literal '#' so tmux does not interpret it as a format directive", () => {
    // Without doubling, tmux would consume the '#' as the start of a directive
    // and the label would render mangled.
    expect(formatLogsPaneLabel("issue#42")).toContain("issue##42");
  });

  it("reads the on-disk sticky expression when called with no argument", () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({ expr: "src:poller" }),
    );
    expect(formatLogsPaneLabel()).toContain("src:poller");
  });
});

describe("parseArgs", () => {
  it("returns defaults with no arguments", () => {
    const f = parseArgs([]);
    expect(f).toEqual({ count: 40, follow: false, showAll: false });
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

  it("parses --all / -a", () => {
    expect(parseArgs(["--all"]).showAll).toBe(true);
    expect(parseArgs(["-a"]).showAll).toBe(true);
  });

  it("parses --raw and --pretty as mode overrides", () => {
    expect(parseArgs(["--raw"]).modeOverride).toBe("raw");
    expect(parseArgs(["--pretty"]).modeOverride).toBe("pretty");
  });

  it("leaves modeOverride undefined by default", () => {
    expect(parseArgs([]).modeOverride).toBeUndefined();
  });

  it("parses --no-saved-filter", () => {
    expect(parseArgs(["--no-saved-filter"]).noSavedFilter).toBe(true);
    expect(parseArgs([]).noSavedFilter).toBeUndefined();
  });

  it("parses --project / -p", () => {
    expect(parseArgs(["--project", "garden"]).project).toBe("garden");
    expect(parseArgs(["-p", "Garden"]).project).toBe("garden");
  });
});

describe("parseFilterExpr", () => {
  it("returns empty fuzzy list for empty input", () => {
    expect(parseFilterExpr("")).toEqual({ fuzzy: [] });
    expect(parseFilterExpr("   ")).toEqual({ fuzzy: [] });
  });

  it("parses structured key:value tokens", () => {
    const r = parseFilterExpr("worker:foo src:poller level:warn project:garden");
    expect(r).toEqual({
      worker: "foo",
      src: "poller",
      level: "warn",
      project: "garden",
      fuzzy: [],
    });
  });

  it("collects bare tokens as fuzzy", () => {
    expect(parseFilterExpr("fix")).toEqual({ fuzzy: ["fix"] });
    expect(parseFilterExpr("fix poller")).toEqual({ fuzzy: ["fix", "poller"] });
  });

  it("mixes structured and fuzzy", () => {
    const r = parseFilterExpr("worker:fix poller error");
    expect(r).toEqual({ worker: "fix", fuzzy: ["poller", "error"] });
  });

  it("treats unknown key prefixes as fuzzy", () => {
    expect(parseFilterExpr("wrkr:foo")).toEqual({ fuzzy: ["wrkr:foo"] });
  });

  it("treats trailing-colon tokens as fuzzy", () => {
    expect(parseFilterExpr("worker:")).toEqual({ fuzzy: ["worker:"] });
  });

  it("first occurrence wins for repeated structured keys", () => {
    const r = parseFilterExpr("worker:first worker:second");
    expect(r.worker).toBe("first");
    expect(r.fuzzy).toEqual([]);
  });

  it("lowercases all values", () => {
    const r = parseFilterExpr("Worker:FOO Bar");
    expect(r.worker).toBe("foo");
    expect(r.fuzzy).toEqual(["bar"]);
  });
});

describe("applyStickyDefaults", () => {
  const base: Filters = { count: 40, follow: false, showAll: false };

  it("returns CLI filters unchanged when sticky is null", () => {
    const f: Filters = { ...base, worker: "foo" };
    expect(applyStickyDefaults(f, null)).toEqual(f);
  });

  it("fills missing fields from sticky", () => {
    const sticky = { worker: "alice", src: "poller", fuzzy: ["bug"] };
    const merged = applyStickyDefaults(base, sticky);
    expect(merged.worker).toBe("alice");
    expect(merged.src).toBe("poller");
    expect(merged.fuzzy).toEqual(["bug"]);
  });

  it("CLI overrides sticky field-by-field", () => {
    const sticky = { worker: "alice", src: "poller" };
    const cli: Filters = { ...base, worker: "bob" };
    const merged = applyStickyDefaults(cli, sticky);
    expect(merged.worker).toBe("bob");
    expect(merged.src).toBe("poller");
  });

  it("preserves sticky fuzzy when CLI has none", () => {
    const sticky = { fuzzy: ["bug"] };
    const merged = applyStickyDefaults(base, sticky);
    expect(merged.fuzzy).toEqual(["bug"]);
  });
});

describe("matchesFilters fuzzy", () => {
  const entry: LogEntry = {
    ts: "2026-03-31T12:00:00Z",
    level: "info",
    src: "poller",
    msg: "checking workers",
    worker: "swift-oak",
  };

  it("matches when fuzzy token appears in worker", () => {
    expect(matchesFilters(entry, { ...entry, fuzzy: ["swift"], count: 40, follow: false } as Filters)).toBe(true);
  });

  it("matches when fuzzy token appears in src", () => {
    expect(matchesFilters(entry, { fuzzy: ["poller"], count: 40, follow: false })).toBe(true);
  });

  it("matches when fuzzy token appears in msg", () => {
    expect(matchesFilters(entry, { fuzzy: ["check"], count: 40, follow: false })).toBe(true);
  });

  it("rejects when fuzzy token appears nowhere", () => {
    expect(matchesFilters(entry, { fuzzy: ["nope"], count: 40, follow: false })).toBe(false);
  });

  it("ANDs multiple fuzzy tokens", () => {
    expect(matchesFilters(entry, { fuzzy: ["swift", "check"], count: 40, follow: false })).toBe(true);
    expect(matchesFilters(entry, { fuzzy: ["swift", "nope"], count: 40, follow: false })).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesFilters(entry, { fuzzy: ["SWIFT"], count: 40, follow: false })).toBe(true);
  });

  it("matches when fuzzy token appears in any data field", () => {
    const navEntry: LogEntry = {
      ts: "2026-03-31T12:00:00Z",
      level: "info",
      src: "navigate",
      msg: "cyclePane",
      data: { direction: 1, from: "_board-worker-quick-shy-sheen", to: "_board-worker-rapt-true-quartz" },
    };
    expect(matchesFilters(navEntry, { fuzzy: ["sheen"], count: 40, follow: false })).toBe(true);
    expect(matchesFilters(navEntry, { fuzzy: ["quartz"], count: 40, follow: false })).toBe(true);
    expect(matchesFilters(navEntry, { fuzzy: ["nope"], count: 40, follow: false })).toBe(false);
  });

  it("matches against nested data values", () => {
    const nested: LogEntry = {
      ts: "2026-03-31T12:00:00Z",
      level: "info",
      src: "review",
      msg: "verdict",
      data: { result: { verdict: "pass", reviewer: "alice" } },
    };
    expect(matchesFilters(nested, { fuzzy: ["alice"], count: 40, follow: false })).toBe(true);
  });

  it("does not match data keys, only values", () => {
    const e: LogEntry = {
      ts: "2026-03-31T12:00:00Z",
      level: "info",
      src: "navigate",
      msg: "cyclePane",
      data: { from: "a", to: "b" },
    };
    expect(matchesFilters(e, { fuzzy: ["from"], count: 40, follow: false })).toBe(false);
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

  it("matches worker in top-level worker field", () => {
    const e: LogEntry = { ...entry, worker: "swift-oak", data: undefined };
    expect(matchesFilters(e, { worker: "swift", count: 40, follow: false })).toBe(true);
    expect(matchesFilters(e, { worker: "bold", count: 40, follow: false })).toBe(false);
  });

  it("prefers top-level worker over data.worker", () => {
    const e: LogEntry = { ...entry, worker: "swift-oak", data: { worker: "bold-ash" } };
    expect(matchesFilters(e, { worker: "swift", count: 40, follow: false })).toBe(true);
    expect(matchesFilters(e, { worker: "bold", count: 40, follow: false })).toBe(false);
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

// projectForEntry's history fallback: when the registry no longer lists a
// worker (killed/cleaned), past log entries that carried data.project are
// scanned to recover the worker→project mapping. Without this, a `wolf`
// worker's old "merge-pending -> merged" lines would render as "system"
// the moment the worker exits the registry.
describe("projectForEntry history fallback (via project filter)", () => {
  beforeEach(() => {
    resetWorkerMapCaches();
  });

  it("resolves project from a past log entry when registry lookup misses", () => {
    // Registry: empty workers (the worker was killed).
    // Log file: one entry pins `drawn-rare-weald` to project `wolf` via
    // data.project, plus the worker-only "→ merged" line we're testing.
    const registryJson = JSON.stringify({ workers: {} });
    const logFile =
      JSON.stringify({
        ts: "2026-05-14T16:20:42.745Z",
        level: "info",
        src: "hook",
        worker: "drawn-rare-weald",
        msg: "claude hook",
        data: { project: "wolf", event: "prompt" },
      }) + "\n";
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const file = String(p);
      if (file.endsWith("dashboard.registry.json")) return registryJson;
      return logFile;
    });
    const entry: LogEntry = {
      ts: "2026-05-14T17:18:35.872Z",
      level: "info",
      src: "poller",
      msg: "merge-pending -> merged",
      worker: "drawn-rare-weald",
    };
    expect(
      matchesFilters(entry, { project: "wolf", count: 40, follow: false }),
    ).toBe(true);
  });

  it("returns null project when no history exists for the worker", () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(() => "");
    const entry: LogEntry = {
      ts: "2026-05-14T17:18:35.872Z",
      level: "info",
      src: "poller",
      msg: "merge-pending -> merged",
      worker: "ghost-worker",
    };
    expect(
      matchesFilters(entry, { project: "wolf", count: 40, follow: false }),
    ).toBe(false);
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

describe("renderDataValue", () => {
  it("collapses embedded newlines so a multi-line error stays one display line", () => {
    // Reproduces the mkfifo failure: String(err) over an execFileSync error
    // carries the child's multi-line stderr. Left raw, the newline broke the
    // detail out of its indented column and rendered the tail at column 0.
    const err = "Error: Command failed: mkfifo /Users/joshua/.garden/sessions/lex-benchmarks-poll-signal\nmkfifo: /Users/joshua/.garden/sessions/lex-benchmarks-poll-signal: File exists";
    const rendered = renderDataValue(err);
    expect(rendered).not.toContain("\n");
    expect(rendered).toBe("Error: Command failed: mkfifo /Users/joshua/.garden/sessions/lex-benchmarks-poll-signal mkfifo: /Users/joshua/.garden/sessions/lex-benchmarks-poll-signal: File exists");
  });

  it("collapses tabs and repeated spaces and trims", () => {
    expect(renderDataValue("  a\t\tb   c \n")).toBe("a b c");
  });

  it("stringifies non-string values", () => {
    expect(renderDataValue({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(renderDataValue(42)).toBe("42");
  });
});

describe("wrapDetail", () => {
  it("returns single line when text fits", () => {
    expect(wrapDetail("hello", 20, 20, 4)).toEqual(["hello"]);
  });

  it("breaks at whitespace within the last quarter of the window", () => {
    // width 20, "the quick brown fox jumps over" — lastIndexOf(" ", 20) is the
    // space at index 19 (after "fox"), past the 75% threshold (= 15). Break
    // preferred there; leading whitespace on the next line is consumed.
    const result = wrapDetail("the quick brown fox jumps over", 20, 20, 4);
    expect(result[0]).toBe("the quick brown fox");
    expect(result[1]).toBe("jumps over");
  });

  it("hard-breaks when no whitespace falls in the preferred range", () => {
    // No spaces at all — single token longer than the window.
    const result = wrapDetail("aaaaaaaaaabbbbbbbbbbcccc", 10, 10, 4);
    expect(result[0]).toBe("aaaaaaaaaa");
    expect(result[1]).toBe("bbbbbbbbbb");
    expect(result[2]).toBe("cccc");
  });

  it("caps at maxLines and ends overflowing output with an ellipsis", () => {
    // Text far longer than 2 lines × 10 chars; force overflow.
    const result = wrapDetail("aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd", 10, 10, 2);
    expect(result).toHaveLength(2);
    expect(result[result.length - 1].endsWith("…")).toBe(true);
  });

  it("returns the raw text when firstWidth is below the wrap threshold", () => {
    // Defensive fallback for absurdly narrow terminals.
    expect(wrapDetail("anything goes here", 5, 5, 4)).toEqual(["anything goes here"]);
  });

  it("uses contWidth for continuation lines", () => {
    // First line wraps at 10, subsequent lines wrap at 6.
    const result = wrapDetail("aaaaaaaaaa bbbbbb cccccc dddddd", 10, 6, 4);
    expect(result[0].length).toBeLessThanOrEqual(10);
    for (let i = 1; i < result.length; i++) {
      // Allow trailing ellipsis on the final overflow line.
      const trimmed = result[i].endsWith("…") ? result[i].slice(0, -1) : result[i];
      expect(trimmed.length).toBeLessThanOrEqual(6);
    }
  });
});
