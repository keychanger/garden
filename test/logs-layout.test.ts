// The pretty-mode gutter: the fixed columns before the first character of
// message text. The logs pane lives in the dashboard's left column — the
// narrower half — so every column the gutter spends is one the message loses.
// These cover the two halves of that: identity columns measured from the names
// that exist, and the date carried by a boundary rule instead of by every
// timestamp.
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { printed.push(strip(line)); });
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
});
