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

vi.mock("node:crypto", () => ({
  default: { randomUUID: vi.fn(() => "uuid-test") },
}));

vi.mock("../src/config.js", () => ({
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import fs from "node:fs";
import { addAlert } from "../src/dashboard/alerts.js";
import {
  parseFindingsBlock,
  recordFindings,
  pendingSuggestions,
  markSuggestion,
  readFindings,
  listFindings,
  getSuggestion,
  type FindingsStore,
} from "../src/dashboard/findings.js";

function mockStore(store: FindingsStore): void {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));
}

function nowMinus(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe("parseFindingsBlock", () => {
  it("returns null when no findings block is present", () => {
    expect(parseFindingsBlock("Just some review prose.")).toBeNull();
  });

  it("extracts findings from a fenced block", () => {
    const body = 'Some prose\n```findings\n[{"category":"missing-tests","summary":"No tests for new branch."}]\n```\nmore prose';
    const result = parseFindingsBlock(body);
    expect(result).toEqual([
      { category: "missing-tests", summary: "No tests for new branch." },
    ]);
  });

  it("normalizes category to lowercase", () => {
    const body = '```findings\n[{"category":"Stale-Test","summary":"x"}]\n```';
    expect(parseFindingsBlock(body)?.[0].category).toBe("stale-test");
  });

  it("rejects malformed JSON", () => {
    const body = "```findings\nnot json\n```";
    expect(parseFindingsBlock(body)).toBeNull();
  });

  it("skips entries with invalid category or empty summary", () => {
    const body = '```findings\n[{"category":"bad space","summary":"x"},{"category":"ok","summary":""},{"category":"good","summary":"fine"}]\n```';
    const result = parseFindingsBlock(body);
    expect(result).toEqual([{ category: "good", summary: "fine" }]);
  });

  it("returns empty array when block is an empty list", () => {
    expect(parseFindingsBlock("```findings\n[]\n```")).toEqual([]);
  });

  it("returns null when JSON is not an array", () => {
    expect(parseFindingsBlock('```findings\n{"category":"x","summary":"y"}\n```')).toBeNull();
  });
});

describe("recordFindings", () => {
  it("is a no-op when body contains no findings block", () => {
    recordFindings({ project: "p", worker: "w", verdict: "fixed", body: "plain text" });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("persists findings to the store", () => {
    recordFindings({
      project: "p", worker: "w", verdict: "fixed",
      body: '```findings\n[{"category":"cat-a","summary":"s1"}]\n```',
    });
    expect(fs.writeFileSync).toHaveBeenCalled();
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string) as FindingsStore;
    expect(written.findings).toHaveLength(1);
    expect(written.findings[0]).toMatchObject({
      project: "p", worker: "w", verdict: "fixed", category: "cat-a", summary: "s1",
    });
    expect(written.suggestions["cat-a"].status).toBe("pending");
  });

  it("does NOT emit an alert below threshold", () => {
    recordFindings({
      project: "p", worker: "w", verdict: "fixed",
      body: '```findings\n[{"category":"cat-a","summary":"s1"}]\n```',
    });
    expect(addAlert).not.toHaveBeenCalled();
  });

  it("emits an alert on first threshold crossing (3 findings, 2 workers)", () => {
    const priorFindings = [
      { id: "1", ts: nowMinus(1), project: "p", worker: "w1", verdict: "fixed" as const, category: "cat-a", summary: "s1" },
      { id: "2", ts: nowMinus(1), project: "p", worker: "w1", verdict: "fixed" as const, category: "cat-a", summary: "s2" },
    ];
    mockStore({ findings: priorFindings, suggestions: { "cat-a": { status: "pending", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1) } } });

    recordFindings({
      project: "p", worker: "w2", verdict: "fixed",
      body: '```findings\n[{"category":"cat-a","summary":"s3"}]\n```',
    });

    expect(addAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addAlert).mock.calls[0][0]).toMatchObject({
      level: "warn",
      source: "rules",
    });
  });

  it("does not re-alert on subsequent findings after crossing", () => {
    const priorFindings = Array.from({ length: 4 }, (_, i) => ({
      id: String(i), ts: nowMinus(1), project: "p", worker: `w${(i % 2) + 1}`,
      verdict: "fixed" as const, category: "cat-a", summary: `s${i}`,
    }));
    mockStore({
      findings: priorFindings,
      suggestions: {
        "cat-a": {
          status: "pending", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1),
          alertFiredAt: nowMinus(1),
        },
      },
    });

    recordFindings({
      project: "p", worker: "w3", verdict: "fixed",
      body: '```findings\n[{"category":"cat-a","summary":"s5"}]\n```',
    });

    expect(addAlert).not.toHaveBeenCalled();
  });

  it("does not alert for dismissed categories", () => {
    const priorFindings = [
      { id: "1", ts: nowMinus(1), project: "p", worker: "w1", verdict: "fixed" as const, category: "cat-a", summary: "s1" },
      { id: "2", ts: nowMinus(1), project: "p", worker: "w2", verdict: "fixed" as const, category: "cat-a", summary: "s2" },
    ];
    mockStore({
      findings: priorFindings,
      suggestions: { "cat-a": { status: "dismissed", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1), dismissedAt: nowMinus(0.5) } },
    });

    recordFindings({
      project: "p", worker: "w3", verdict: "fixed",
      body: '```findings\n[{"category":"cat-a","summary":"s3"}]\n```',
    });

    expect(addAlert).not.toHaveBeenCalled();
  });

  it("caps the findings log at 1000 entries", () => {
    const priorFindings = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i), ts: nowMinus(0.1), project: "p", worker: "w",
      verdict: "fixed" as const, category: "cat-a", summary: `s${i}`,
    }));
    mockStore({ findings: priorFindings, suggestions: {} });

    recordFindings({
      project: "p", worker: "w", verdict: "fixed",
      body: '```findings\n[{"category":"cat-a","summary":"newest"}]\n```',
    });

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string) as FindingsStore;
    expect(written.findings).toHaveLength(1000);
    expect(written.findings[999].summary).toBe("newest");
    expect(written.findings[0].id).not.toBe("0");
  });

  it("ignores findings outside the 30-day window for threshold", () => {
    const priorFindings = [
      { id: "1", ts: nowMinus(40), project: "p", worker: "w1", verdict: "fixed" as const, category: "cat-a", summary: "old" },
      { id: "2", ts: nowMinus(40), project: "p", worker: "w2", verdict: "fixed" as const, category: "cat-a", summary: "old" },
    ];
    mockStore({ findings: priorFindings, suggestions: { "cat-a": { status: "pending", firstSeenAt: nowMinus(40), lastSeenAt: nowMinus(40) } } });

    recordFindings({
      project: "p", worker: "w3", verdict: "fixed",
      body: '```findings\n[{"category":"cat-a","summary":"new"}]\n```',
    });

    // Only 1 finding within 30 days — below threshold
    expect(addAlert).not.toHaveBeenCalled();
  });
});

describe("pendingSuggestions", () => {
  it("returns empty when no findings exist", () => {
    expect(pendingSuggestions()).toEqual([]);
  });

  it("includes only categories over threshold", () => {
    const findings = [
      { id: "1", ts: nowMinus(1), project: "p", worker: "w1", verdict: "fixed" as const, category: "cat-a", summary: "s1" },
      { id: "2", ts: nowMinus(1), project: "p", worker: "w2", verdict: "fixed" as const, category: "cat-a", summary: "s2" },
      { id: "3", ts: nowMinus(1), project: "p", worker: "w3", verdict: "fixed" as const, category: "cat-a", summary: "s3" },
      { id: "4", ts: nowMinus(1), project: "p", worker: "w1", verdict: "fixed" as const, category: "cat-b", summary: "only-one" },
    ];
    mockStore({
      findings,
      suggestions: {
        "cat-a": { status: "pending", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1) },
        "cat-b": { status: "pending", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1) },
      },
    });

    const result = pendingSuggestions();
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("cat-a");
    expect(result[0].count).toBe(3);
    expect(result[0].distinctWorkers).toBe(3);
  });

  it("excludes accepted and dismissed categories", () => {
    const findings = Array.from({ length: 4 }, (_, i) => ({
      id: String(i), ts: nowMinus(1), project: "p", worker: `w${i + 1}`,
      verdict: "fixed" as const, category: "cat-a", summary: `s${i}`,
    }));
    mockStore({
      findings,
      suggestions: {
        "cat-a": { status: "accepted", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1), acceptedAt: nowMinus(0.1) },
      },
    });

    expect(pendingSuggestions()).toEqual([]);
  });

  it("sorts by count descending", () => {
    const findings = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`, ts: nowMinus(1), project: "p", worker: `w${i + 1}`,
        verdict: "fixed" as const, category: "cat-a", summary: `sa${i}`,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `b${i}`, ts: nowMinus(1), project: "p", worker: `w${i + 1}`,
        verdict: "fixed" as const, category: "cat-b", summary: `sb${i}`,
      })),
    ];
    mockStore({
      findings,
      suggestions: {
        "cat-a": { status: "pending", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1) },
        "cat-b": { status: "pending", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1) },
      },
    });

    const result = pendingSuggestions();
    expect(result.map(s => s.category)).toEqual(["cat-a", "cat-b"]);
  });
});

describe("markSuggestion", () => {
  it("marks a category as accepted and records appendedTo", () => {
    markSuggestion("cat-a", "accepted", { appendedTo: "/tmp/rules.md" });
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string) as FindingsStore;
    expect(written.suggestions["cat-a"].status).toBe("accepted");
    expect(written.suggestions["cat-a"].appendedTo).toBe("/tmp/rules.md");
    expect(written.suggestions["cat-a"].acceptedAt).toBeTruthy();
  });

  it("marks a category as dismissed", () => {
    markSuggestion("cat-a", "dismissed");
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string) as FindingsStore;
    expect(written.suggestions["cat-a"].status).toBe("dismissed");
    expect(written.suggestions["cat-a"].dismissedAt).toBeTruthy();
  });
});

describe("readFindings", () => {
  it("returns an empty store when file does not exist", () => {
    expect(readFindings()).toEqual({ findings: [], suggestions: {} });
  });

  it("returns an empty store for corrupt JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json{{");
    expect(readFindings()).toEqual({ findings: [], suggestions: {} });
  });

  it("tolerates missing fields in a partial store", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{"findings":null,"suggestions":"bad"}');
    expect(readFindings()).toEqual({ findings: [], suggestions: {} });
  });
});

describe("listFindings", () => {
  it("filters by project", () => {
    const findings = [
      { id: "1", ts: nowMinus(1), project: "p1", worker: "w", verdict: "fixed" as const, category: "c", summary: "a" },
      { id: "2", ts: nowMinus(1), project: "p2", worker: "w", verdict: "fixed" as const, category: "c", summary: "b" },
    ];
    mockStore({ findings, suggestions: {} });
    expect(listFindings({ project: "p1" })).toHaveLength(1);
    expect(listFindings({ project: "p1" })[0].project).toBe("p1");
  });

  it("returns all without filter", () => {
    const findings = [
      { id: "1", ts: nowMinus(1), project: "p1", worker: "w", verdict: "fixed" as const, category: "c", summary: "a" },
      { id: "2", ts: nowMinus(1), project: "p2", worker: "w", verdict: "fixed" as const, category: "c", summary: "b" },
    ];
    mockStore({ findings, suggestions: {} });
    expect(listFindings()).toHaveLength(2);
  });
});

describe("getSuggestion", () => {
  it("returns null for unknown category", () => {
    expect(getSuggestion("unknown")).toBeNull();
  });

  it("exposes appendedTo for accepted categories", () => {
    const findings = [
      { id: "1", ts: nowMinus(1), project: "p", worker: "w", verdict: "fixed" as const, category: "cat-a", summary: "s1" },
    ];
    mockStore({
      findings,
      suggestions: {
        "cat-a": {
          status: "accepted", firstSeenAt: nowMinus(1), lastSeenAt: nowMinus(1),
          acceptedAt: nowMinus(0.1), appendedTo: "/rules.md",
        },
      },
    });
    expect(getSuggestion("cat-a")?.appendedTo).toBe("/rules.md");
    expect(getSuggestion("cat-a")?.status).toBe("accepted");
  });
});
