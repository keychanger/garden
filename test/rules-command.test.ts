import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

const rlAnswers: string[] = [];
vi.mock("node:readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: (_q: string, cb: (answer: string) => void) => {
        const next = rlAnswers.shift() ?? "";
        cb(next);
      },
      close: vi.fn(),
    })),
  },
}));

vi.mock("../src/config.js", () => ({
  GARDEN_DIR: "/tmp/garden",
  getProject: vi.fn((name: string) => ({
    name,
    path: `/repo/${name}`,
  })),
  tryGetProject: vi.fn((name: string) => ({
    name,
    path: `/repo/${name}`,
  })),
}));

vi.mock("../src/dashboard/findings.js", () => ({
  pendingSuggestions: vi.fn(() => []),
  getSuggestion: vi.fn(() => null),
  markSuggestion: vi.fn(),
  listFindings: vi.fn(() => []),
}));

vi.mock("../src/output.js", () => ({
  isTTY: true,
  outputLines: vi.fn((items: unknown[], pretty?: (x: unknown) => string) => {
    for (const item of items) console.log(pretty ? pretty(item) : JSON.stringify(item));
  }),
}));

import fs from "node:fs";
import {
  pendingSuggestions, getSuggestion, markSuggestion, listFindings,
  type SuggestionSummary,
} from "../src/dashboard/findings.js";
import {
  rules, parseAcceptFlags, buildRuleBlock, humanize,
} from "../src/commands/rules.js";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
  };
  return { lines, restore: () => { console.log = orig; } };
}

function makeSummary(overrides?: Partial<SuggestionSummary>): SuggestionSummary {
  return {
    category: "cat-a",
    count: 3,
    distinctWorkers: 2,
    projects: ["p1"],
    workers: ["p1/w1", "p1/w2"],
    examples: ["thing 1", "thing 2"],
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-02T00:00:00Z",
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rlAnswers.length = 0;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

// --- parseAcceptFlags ---

describe("parseAcceptFlags", () => {
  it("requires a category as the first positional", () => {
    expect(() => parseAcceptFlags([])).toThrow(/Usage/);
    expect(() => parseAcceptFlags(["--global"])).toThrow(/Usage/);
  });

  it("parses --global flag", () => {
    const f = parseAcceptFlags(["cat-a", "--global"]);
    expect(f).toMatchObject({ category: "cat-a", global: true, confirm: false });
  });

  it("parses --project <name>", () => {
    const f = parseAcceptFlags(["cat-a", "--project", "myproj"]);
    expect(f.project).toBe("myproj");
  });

  it("parses --rule and --confirm", () => {
    const f = parseAcceptFlags(["cat-a", "--rule", "Do X.", "--confirm"]);
    expect(f.rule).toBe("Do X.");
    expect(f.confirm).toBe(true);
  });

  it("rejects both --global and --project", () => {
    expect(() => parseAcceptFlags(["cat-a", "--global", "--project", "p"])).toThrow(/at most one/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseAcceptFlags(["cat-a", "--frobnicate"])).toThrow(/Unknown flag/);
  });
});

// --- humanize ---

describe("humanize", () => {
  it("converts kebab-case to title case", () => {
    expect(humanize("stale-test-after-refactor")).toBe("Stale Test After Refactor");
  });

  it("handles single words", () => {
    expect(humanize("coverage")).toBe("Coverage");
  });

  it("drops empty segments", () => {
    expect(humanize("a--b")).toBe("A B");
  });
});

// --- buildRuleBlock ---

describe("buildRuleBlock", () => {
  it("includes the rule text when provided", () => {
    const block = buildRuleBlock(makeSummary(), "Always write tests for new code paths.");
    expect(block).toContain("Always write tests for new code paths.");
    expect(block).toContain("## Cat A");
    expect(block).toContain("- thing 1");
    expect(block).toContain("- thing 2");
  });

  it("omits rule text when not provided", () => {
    const block = buildRuleBlock(makeSummary());
    expect(block).toContain("Observed in 3 reviewer findings across 2 workers");
    expect(block).toMatch(/## Cat A\n\nObserved/);
  });

  it("pluralizes correctly for single counts", () => {
    const block = buildRuleBlock(makeSummary({ count: 1, distinctWorkers: 1 }));
    expect(block).toContain("1 reviewer finding across 1 worker:");
  });
});

// --- rules dispatch ---

describe("rules command dispatch", () => {
  it("defaults to suggest when no subcommand given", async () => {
    const cap = captureLog();
    await rules([]);
    cap.restore();
    expect(cap.lines.some(l => l.includes("No pending rule suggestions"))).toBe(true);
  });

  it("throws on unknown subcommand", async () => {
    await expect(rules(["frobnicate"])).rejects.toThrow(/Unknown subcommand/);
  });
});

// --- suggest ---

describe("rules suggest", () => {
  it("prints a message when no suggestions pending", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([]);
    const cap = captureLog();
    await rules(["suggest"]);
    cap.restore();
    expect(cap.lines.some(l => l.includes("No pending rule suggestions"))).toBe(true);
  });

  it("lists pending suggestions with count and examples", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([makeSummary()]);
    const cap = captureLog();
    await rules(["suggest"]);
    cap.restore();
    const out = cap.lines.join("\n");
    expect(out).toContain("cat-a");
    expect(out).toContain("count: 3");
    expect(out).toContain("workers: 2");
    expect(out).toContain("- thing 1");
  });

  it("labels scope as global when findings span multiple projects", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([makeSummary({ projects: ["p1", "p2"] })]);
    const cap = captureLog();
    await rules(["suggest"]);
    cap.restore();
    const out = cap.lines.join("\n");
    expect(out).toContain("global (2 projects)");
  });
});

// --- list (non-interactive) ---

describe("rules list", () => {
  it("prints suggestions without the accept/dismiss footer", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([makeSummary()]);
    const cap = captureLog();
    await rules(["list"]);
    cap.restore();
    const out = cap.lines.join("\n");
    expect(out).toContain("cat-a");
    expect(out).not.toContain("Accept one:");
  });
});

// --- interactive suggest ---

describe("rules suggest (interactive TTY)", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  it("accepts on 'a' with a rule, appends and marks accepted", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([makeSummary()]);
    rlAnswers.push("a", "Do not do X.");
    const cap = captureLog();
    await rules(["suggest"]);
    cap.restore();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(markSuggestion).toHaveBeenCalledWith("cat-a", "accepted", expect.objectContaining({
      appendedTo: "/repo/p1/.garden/rules.md",
    }));
  });

  it("accepts with empty rule text (evidence-only)", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([makeSummary()]);
    rlAnswers.push("a", "");
    await rules(["suggest"]);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(markSuggestion).toHaveBeenCalledWith("cat-a", "accepted", expect.anything());
  });

  it("dismisses on 'd' and does not write", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([makeSummary()]);
    rlAnswers.push("d");
    await rules(["suggest"]);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(markSuggestion).toHaveBeenCalledWith("cat-a", "dismissed");
  });

  it("skips on 's' without marking", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([makeSummary()]);
    rlAnswers.push("s");
    await rules(["suggest"]);
    expect(markSuggestion).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("walks multiple suggestions in order", async () => {
    vi.mocked(pendingSuggestions).mockReturnValue([
      makeSummary({ category: "cat-a" }),
      makeSummary({ category: "cat-b" }),
    ]);
    rlAnswers.push("d", "s");
    await rules(["suggest"]);
    expect(markSuggestion).toHaveBeenCalledTimes(1);
    expect(markSuggestion).toHaveBeenCalledWith("cat-a", "dismissed");
  });
});

// --- accept ---

describe("rules accept", () => {
  it("errors when category has no findings", async () => {
    vi.mocked(getSuggestion).mockReturnValue(null);
    await expect(rules(["accept", "unknown"])).rejects.toThrow(/No findings recorded/);
  });

  it("errors when category is already accepted", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary({ status: "accepted", appendedTo: "/rules.md" }));
    await expect(rules(["accept", "cat-a"])).rejects.toThrow(/already accepted/);
  });

  it("errors when category was dismissed", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary({ status: "dismissed" }));
    await expect(rules(["accept", "cat-a"])).rejects.toThrow(/previously dismissed/);
  });

  it("without --confirm, prints the proposed block and does not write", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary());
    const cap = captureLog();
    await rules(["accept", "cat-a", "--rule", "Write tests."]);
    cap.restore();
    const out = cap.lines.join("\n");
    expect(out).toContain("Proposed append");
    expect(out).toContain("Write tests.");
    expect(out).toContain("Re-run with --confirm");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(markSuggestion).not.toHaveBeenCalled();
  });

  it("with --confirm, appends to rules.md and marks accepted", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary());
    const cap = captureLog();
    await rules(["accept", "cat-a", "--rule", "Write tests.", "--confirm"]);
    cap.restore();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(markSuggestion).toHaveBeenCalledWith("cat-a", "accepted", expect.objectContaining({
      appendedTo: expect.stringContaining("rules.md"),
    }));
  });

  it("defaults scope to project when findings are from a single project", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary({ projects: ["p1"] }));
    const cap = captureLog();
    await rules(["accept", "cat-a", "--confirm"]);
    cap.restore();
    const appendedTo = vi.mocked(markSuggestion).mock.calls[0][2]?.appendedTo;
    expect(appendedTo).toBe("/repo/p1/.garden/rules.md");
  });

  it("defaults scope to global when findings span multiple projects", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary({ projects: ["p1", "p2"] }));
    await rules(["accept", "cat-a", "--confirm"]);
    const appendedTo = vi.mocked(markSuggestion).mock.calls[0][2]?.appendedTo;
    expect(appendedTo).toBe("/tmp/garden/rules.md");
  });

  it("respects --global override", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary({ projects: ["p1"] }));
    await rules(["accept", "cat-a", "--global", "--confirm"]);
    const appendedTo = vi.mocked(markSuggestion).mock.calls[0][2]?.appendedTo;
    expect(appendedTo).toBe("/tmp/garden/rules.md");
  });

  it("respects --project override", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary({ projects: ["p1", "p2"] }));
    await rules(["accept", "cat-a", "--project", "other", "--confirm"]);
    const appendedTo = vi.mocked(markSuggestion).mock.calls[0][2]?.appendedTo;
    expect(appendedTo).toBe("/repo/other/.garden/rules.md");
  });
});

// --- dismiss ---

describe("rules dismiss", () => {
  it("requires a category", async () => {
    await expect(rules(["dismiss"])).rejects.toThrow(/Usage/);
  });

  it("errors when category has no findings", async () => {
    vi.mocked(getSuggestion).mockReturnValue(null);
    await expect(rules(["dismiss", "unknown"])).rejects.toThrow(/No findings/);
  });

  it("errors when category already accepted", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary({ status: "accepted" }));
    await expect(rules(["dismiss", "cat-a"])).rejects.toThrow(/already accepted/);
  });

  it("marks a pending category as dismissed", async () => {
    vi.mocked(getSuggestion).mockReturnValue(makeSummary());
    await rules(["dismiss", "cat-a"]);
    expect(markSuggestion).toHaveBeenCalledWith("cat-a", "dismissed");
  });
});

// --- findings ---

describe("rules findings", () => {
  it("prints a friendly message when empty", async () => {
    vi.mocked(listFindings).mockReturnValue([]);
    const cap = captureLog();
    await rules(["findings"]);
    cap.restore();
    expect(cap.lines.some(l => l.includes("No findings recorded"))).toBe(true);
  });

  it("passes through --project filter", async () => {
    vi.mocked(listFindings).mockReturnValue([]);
    await rules(["findings", "--project", "myproj"]);
    expect(listFindings).toHaveBeenCalledWith({ project: "myproj" });
  });

  it("prints each finding in TTY mode", async () => {
    vi.mocked(listFindings).mockReturnValue([
      { id: "1", ts: "2026-01-01T12:00:00Z", project: "p", worker: "w", verdict: "fixed", category: "cat-a", summary: "x" },
    ]);
    const cap = captureLog();
    await rules(["findings"]);
    cap.restore();
    const out = cap.lines.join("\n");
    expect(out).toContain("p/w");
    expect(out).toContain("FIXED");
    expect(out).toContain("cat-a");
  });
});
