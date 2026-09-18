// The pretty-mode gutter: the fixed columns before the first character of
// message text. The logs pane lives in the dashboard's left column — the
// narrower half — so every column the gutter spends is one the message loses.
// These cover the two halves of that: identity columns measured from the names
// that exist, and the date carried by a boundary rule instead of by every
// timestamp.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

let logContent = "";

const registry = {
  workers: {
    garden: [{ name: "fell-white-deer" }, { name: "slight-ripe-stir" }],
    board: [{ name: "spry-crux" }],
  },
};

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((p: string) => {
      if (String(p).endsWith("dashboard.registry.json")) return JSON.stringify(registry);
      if (String(p).endsWith("dashboard.log")) return logContent;
      return "";
    }),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0 })),
    openSync: vi.fn(() => 3),
    readSync: vi.fn(),
    closeSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    SESSIONS_DIR: "/tmp/fake-sessions",
    projectDisplayName: actual.projectDisplayName,
    logColorKeyForProject: () => null,
    getLogsMode: () => "pretty",
    loadConfig: () => ({
      projects: {
        garden: { path: "/code/garden" },
        board: { path: "/code/board" },
        website: { path: "/code/website", displayName: "academicimpressions.com" },
      },
    }),
  };
});

vi.mock("../src/output.js", () => ({ isTTY: true }));

const {
  formatPrettyEntry, formatDateRule, prettyLayout, resetWorkerMapCaches, resetDateRuleState,
  logs,
} = await import("../src/commands/logs.js");

// Visible text only — these assertions are about columns, not styling.
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function entry(over: Partial<{ ts: string; worker: string; msg: string; data: Record<string, unknown> }> = {}) {
  return {
    ts: new Date(2026, 8, 17, 14, 51, 40).toISOString(),
    level: "info",
    src: "hook",
    msg: "worker window resized",
    ...over,
    data: { project: "garden", ...(over.data ?? {}) },
  };
}

beforeEach(() => {
  resetWorkerMapCaches();
  resetDateRuleState();
  logContent = "";
});

// Render the whole batch the way `garden logs` does and hand back the visible
// lines, so the date rules are observed where they are actually emitted.
async function renderLog(...entries: object[]): Promise<string[]> {
  logContent = entries.map(e => JSON.stringify(e)).join("\n");
  const printed: string[] = [];
  // Split: one console.log can carry a whole multi-line render, and these
  // assertions are about individual display rows.
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    for (const row of strip(String(line)).split("\n")) printed.push(row);
  });
  try {
    await logs([]);
  } finally {
    spy.mockRestore();
  }
  return printed;
}

describe("prettyLayout", () => {
  it("sizes the identity columns to the names that exist, not to the longest possible name", () => {
    const layout = prettyLayout(false);
    // Widest live worker is "slight-ripe-stir" (16), not the 20-char ceiling
    // the adj-adj-noun generator could produce.
    expect(layout.worker).toBe(16);
    // "board" (5) and "garden" (6) are under the 6-char floor's reach; the
    // column takes the floor rather than collapsing.
    expect(layout.project).toBe(6);
    expect(layout.timestamp).toBe(8); // HH:MM:SS — the date rides a rule
  });

  it("does not let a name that must be truncated anyway pin the column to the cap", () => {
    // "academicimpressions.com" (23) exceeds the 16-char cap, so it is cut at
    // whatever the column turns out to be. Giving it a vote would spend 10
    // columns of every other project's rows on one project's long label.
    expect(prettyLayout(false).project).toBe(6);
  });

  it("is stable across calls, because --follow appends to rows already on screen", () => {
    const first = prettyLayout(false);
    const second = prettyLayout(false);
    expect(second).toEqual(first);
  });

  it("gives relative mode its own timestamp width and the same identity columns", () => {
    const abs = prettyLayout(false);
    const rel = prettyLayout(true);
    expect(rel.timestamp).toBe(11); // the >24h "MM-DD HH:MM" fallback
    expect(rel.project).toBe(abs.project);
    expect(rel.worker).toBe(abs.worker);
    expect(rel.messageCol).toBe(abs.messageCol + 3);
  });
});

describe("formatPrettyEntry gutter", () => {
  it("starts the message at the layout's message column", () => {
    const line = strip(formatPrettyEntry(entry({ worker: "fell-white-deer" }), false));
    expect(line.indexOf("worker window resized")).toBe(prettyLayout(false).messageCol);
  });

  it("indents continuation lines to the same column, so details align under the message", () => {
    const rendered = strip(formatPrettyEntry(
      entry({ worker: "fell-white-deer", data: { baseBranch: "main" } }), false)).split("\n");
    expect(rendered).toHaveLength(2);
    expect(rendered[1].indexOf("↳")).toBe(prettyLayout(false).messageCol);
  });

  it("prints the clock without a date", () => {
    const line = strip(formatPrettyEntry(entry(), false));
    expect(line.startsWith("14:51:40 ")).toBe(true);
    expect(line).not.toContain("09-17");
  });

  it("pads a short worker name and leaves a long one to push its own row", () => {
    // Overflow never truncates a worker name: it is the argument `garden logs
    // -w` and `garden kick` take, so a clipped one is unusable.
    const short = strip(formatPrettyEntry(entry({ worker: "spry-crux" }), false));
    const long = strip(formatPrettyEntry(entry({ worker: "a-really-long-worker-name" }), false));
    expect(short.indexOf("worker window")).toBe(prettyLayout(false).messageCol);
    expect(long).toContain("a-really-long-worker-name");
    expect(long.indexOf("worker window")).toBeGreaterThan(prettyLayout(false).messageCol);
  });
});

describe("formatDateRule", () => {
  it("names the weekday and date and fills the pane width", () => {
    const rule = strip(formatDateRule(new Date(2026, 8, 17, 0, 0, 0).toISOString(), 40));
    expect(rule.startsWith("── Thu 09-17 ")).toBe(true);
    expect(rule).toHaveLength(40);
  });

  it("stays a rule when the width is too small to fill", () => {
    const rule = strip(formatDateRule(new Date(2026, 8, 17, 0, 0, 0).toISOString(), 4));
    expect(rule).toContain("Thu 09-17");
    expect(rule.endsWith("──")).toBe(true);
  });

  it("returns nothing for an unparseable timestamp rather than a rule reading NaN", () => {
    expect(formatDateRule("not-a-date", 40)).toBe("");
  });
});

describe("date rules in a rendered batch", () => {
  const at = (day: number, hour: number) =>
    new Date(2026, 8, day, hour, 30, 0).toISOString();

  it("opens with a rule and adds one only where the day changes", async () => {
    const printed = await renderLog(
      entry({ ts: at(16, 9), msg: "first" }),
      entry({ ts: at(16, 23), msg: "second" }),
      entry({ ts: at(17, 1), msg: "third" }),
    );
    const rules = printed.filter(l => l.startsWith("──"));
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain("Wed 09-16");
    expect(rules[1]).toContain("Thu 09-17");
    // The rule precedes the first entry of its day, so the run below it
    // belongs to it.
    expect(printed.findIndex(l => l.includes("Thu 09-17")))
      .toBe(printed.findIndex(l => l.includes("third")) - 1);
  });

  it("leaves raw mode alone — its timestamps already carry the date", async () => {
    logContent = [entry({ ts: at(16, 9), msg: "first" }), entry({ ts: at(17, 1), msg: "second" })]
      .map(e => JSON.stringify(e)).join("\n");
    const printed: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { printed.push(strip(line)); });
    try {
      await logs(["--raw"]);
    } finally {
      spy.mockRestore();
    }
    expect(printed.some(l => l.startsWith("──"))).toBe(false);
    expect(printed[0]).toContain("09-16");
  });

  it("emits no rule between entries of the same day", async () => {
    const printed = await renderLog(
      entry({ ts: at(17, 9), msg: "first" }),
      entry({ ts: at(17, 14), msg: "second" }),
    );
    expect(printed.filter(l => l.startsWith("──"))).toHaveLength(1);
  });

  it("keeps repeated entries under their own day's rule", async () => {
    const printed = await renderLog(
      entry({ ts: at(16, 22) }),
      entry({ ts: at(16, 23) }),
      entry({ ts: at(17, 1) }),
      entry({ ts: at(17, 2) }),
    );
    expect(printed).toHaveLength(4);
    expect(printed[0]).toContain("Wed 09-16");
    expect(printed[1]).toContain("(×2)");
    expect(printed[2]).toContain("Thu 09-17");
    expect(printed[3]).toContain("(×2)");
  });
});

describe("date rules while following logs", () => {
  it("continues the backlog's day and resets repeats before the next day's rule", async () => {
    vi.useFakeTimers();
    const signals = ["SIGINT", "SIGTERM"] as const;
    const originalListeners = new Set(signals.flatMap(signal => process.listeners(signal)));
    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(line => { printed.push(strip(line)); });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const at = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
    logContent = JSON.stringify(entry({ ts: at(16, 20), msg: "backlog" })) + "\n";
    vi.mocked(fs.statSync).mockImplementation(() => ({ size: Buffer.byteLength(logContent) }) as fs.Stats);
    let appended = "";
    vi.mocked(fs.readSync).mockImplementation((_fd, buffer) => Buffer.from(appended).copy(buffer as Buffer));
    const pending = logs(["--follow"]);
    const append = async (day: number, hour: number) => {
      appended = JSON.stringify(entry({ ts: at(day, hour), data: { baseBranch: "main" } })) + "\n";
      logContent += appended;
      writeSpy.mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      return strip(writeSpy.mock.calls.map(call => String(call[0])).join(""));
    };
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(printed.filter(line => line.startsWith("──"))).toHaveLength(1);
      expect(await append(16, 21)).not.toContain("──");
      expect(await append(16, 22)).toContain("(×2)");
      const midnight = await append(17, 0);
      expect(midnight).toContain("Thu 09-17");
      expect(midnight).not.toContain("\x1b[A");
      expect(midnight).not.toContain("(×");
      const repeat = await append(17, 1);
      expect(repeat).toContain("(×2)");
      expect(repeat).toContain("\x1b[A");
      expect(repeat).not.toContain("──");
    } finally {
      for (const signal of signals) {
        for (const listener of process.listeners(signal)) {
          if (originalListeners.has(listener)) continue;
          if (signal === "SIGINT") (listener as () => void)();
          process.removeListener(signal, listener);
        }
      }
      await pending;
      consoleSpy.mockRestore();
      writeSpy.mockRestore();
      vi.mocked(fs.statSync).mockReset();
      vi.mocked(fs.readSync).mockReset();
      vi.useRealTimers();
    }
  });
});

describe("no rendered row overruns the pane", () => {
  // The defect this covers: headlines were emitted raw while only details were
  // wrapped, so any message wider than the message column ran off and the
  // terminal re-wrapped the tail to column 0, out of alignment with every
  // other row. Measured at 83 of 4000 real entries on a 97-column pane, the
  // worst an alert at 412 columns.
  const longHeadline = "branch already contains the base tip; skipping rebase and proceeding straight to the merge queue";

  function widthsOf(rendered: string): number[] {
    return strip(rendered).split("\n").map(l => l.length);
  }

  it("wraps a long headline into the message column instead of overrunning", () => {
    process.stdout.columns = 97;
    const rendered = formatPrettyEntry(entry({ worker: "fell-white-deer", msg: longHeadline }), false);
    const lines = strip(rendered).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(Math.max(...widthsOf(rendered))).toBeLessThanOrEqual(97);
    // A wrapped headline is still the message, so its continuations carry no
    // "↳" — that glyph means "detail of the message above".
    expect(lines[1]).not.toContain("↳");
    expect(lines[1].indexOf(lines[1].trim())).toBe(prettyLayout(false).messageCol);
  });

  it("holds across pane widths, with and without details", () => {
    for (const width of [70, 80, 97, 110, 146, 200]) {
      process.stdout.columns = width;
      for (const e of [
        entry({ worker: "fell-white-deer", msg: longHeadline }),
        entry({ worker: "fell-white-deer", msg: longHeadline, data: { worktreePath: "/Users/jic/.garden/worktrees/garden/fell-white-deer", baseBranch: "develop" } }),
        entry({ worker: "fell-white-deer", msg: "x".repeat(400) }),
      ]) {
        expect(Math.max(...widthsOf(formatPrettyEntry(e, false)))).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps a worker name that overflows its column from pushing the row over", () => {
    // An over-long worker name is never truncated (it is the argument `garden
    // logs -w` takes), so it shifts its own row right — and that shift has to
    // come off the headline's budget.
    process.stdout.columns = 97;
    const rendered = formatPrettyEntry(
      entry({ worker: "a-really-long-worker-name", msg: longHeadline }), false);
    expect(Math.max(...widthsOf(rendered))).toBeLessThanOrEqual(97);
  });

  it("reserves room for the dedup suffix rather than letting it push the line over", async () => {
    process.stdout.columns = 97;
    const repeated = entry({ worker: "fell-white-deer", msg: longHeadline });
    const printed = await renderLog(repeated, repeated, repeated);
    expect(printed.some(l => l.includes("(×3)"))).toBe(true);
    expect(Math.max(...printed.map(l => l.length))).toBeLessThanOrEqual(97);
  });
});
