// Regression suite for the /api/oauth/usage response parser. Each fixture in
// test/fixtures/usage/ captures one historically-observed or historically-
// broken response shape; the table below pins normalizeUsage's output against
// each. When Anthropic changes the response shape, the failing row points
// directly at the fixture that no longer matches reality — far easier to
// triage than "the dashboard meter went blank".
//
// Adding a new fixture: drop the JSON in test/fixtures/usage/ and add a row
// here. The walker asserts every fixture is named in the table, so an
// orphan fixture also fails the suite.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUsage, type UsageData } from "../src/dashboard/usage.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "usage",
);

interface Case {
  fixture: string;
  expected: UsageData;
}

const cases: Case[] = [
  {
    fixture: "max-plan-happy-path.json",
    expected: {
      fiveHour: { pct: 62, resetsAt: "2026-04-15T20:00:00+00:00" },
      weekly:   { pct: 34, resetsAt: "2026-04-19T04:00:00+00:00" },
      scoped:   [{ label: "Fable", pct: 4, resetsAt: "2026-04-20T15:00:00+00:00" }],
    },
  },
  {
    // Multiple weekly_scoped entries → one scoped meter each, in array order.
    fixture: "multi-scoped-limits.json",
    expected: {
      fiveHour: { pct: 50, resetsAt: "2026-04-15T20:00:00+00:00" },
      weekly:   { pct: 30, resetsAt: "2026-04-19T04:00:00+00:00" },
      scoped: [
        { label: "Fable", pct: 12, resetsAt: "2026-04-20T15:00:00+00:00" },
        { label: "Haiku", pct:  7, resetsAt: "2026-04-20T15:00:00+00:00" },
      ],
    },
  },
  {
    fixture: "null-sonnet.json",
    expected: {
      fiveHour: { pct:  4, resetsAt: "2026-04-15T23:00:00+00:00" },
      weekly:   { pct: 32, resetsAt: "2026-04-17T15:00:00+00:00" },
    },
  },
  {
    fixture: "all-null.json",
    expected: {},
  },
  {
    fixture: "missing-buckets.json",
    expected: {
      fiveHour: { pct: 10, resetsAt: "2026-04-15T20:00:00+00:00" },
    },
  },
  {
    fixture: "wrong-typed-pct.json",
    expected: {
      fiveHour: { pct: 10, resetsAt: "2026-04-15T20:00:00+00:00" },
    },
  },
  {
    fixture: "unknown-shape.json",
    expected: {},
  },
  {
    fixture: "extra-usage-enabled.json",
    expected: {
      fiveHour: { pct: 80, resetsAt: "2026-04-15T20:00:00+00:00" },
      weekly:   { pct: 91, resetsAt: "2026-04-19T04:00:00+00:00" },
      extraUsage: { enabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 25 },
    },
  },
  {
    fixture: "wrapped-quota.json",
    expected: {
      fiveHour: { pct: 62, resetsAt: "2026-04-15T20:00:00+00:00" },
      weekly:   { pct: 34, resetsAt: "2026-04-19T04:00:00+00:00" },
      scoped:   [{ label: "Fable", pct: 4, resetsAt: "2026-04-20T15:00:00+00:00" }],
    },
  },
  {
    fixture: "wrapped-all-null.json",
    expected: {},
  },
  {
    // Captured 2026-07-26, hours after a weekly reset with no Fable usage yet:
    // the weekly_scoped entry is still served, at percent 0 with a null
    // resets_at (is_active: false) because the scoped window hasn't opened.
    // The meter survives as an anchor-less 0% bar rather than being dropped.
    fixture: "unopened-scoped-window.json",
    expected: {
      fiveHour: { pct: 1, resetsAt: "2026-07-26T19:59:59.539550+00:00" },
      weekly:   { pct: 0, resetsAt: "2026-08-02T10:59:59.539576+00:00" },
      scoped:   [{ label: "Fable", pct: 0 }],
    },
  },
];

describe("normalizeUsage against recorded response shapes", () => {
  for (const c of cases) {
    it(`parses ${c.fixture} as expected`, () => {
      const body = fs.readFileSync(path.join(FIXTURES_DIR, c.fixture), "utf8");
      const parsed = JSON.parse(body);
      expect(normalizeUsage(parsed)).toEqual(c.expected);
    });
  }

  it("every fixture in fixtures/usage is exercised by the table", () => {
    const onDisk = fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const inTable = cases.map((c) => c.fixture).sort();
    expect(onDisk).toEqual(inTable);
  });
});
