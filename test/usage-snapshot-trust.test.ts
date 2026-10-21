// The usage snapshots are read by the unsandboxed poller and the auto-continue
// gate. They live in the control tree, and a malformed one reads as absent
// instead of crashing a reader or acting on a value garden never wrote.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// paths freeze HOME at import, so the modules load after useTmpHome redirects it.
const env = useTmpHome();

async function usage() {
  return await import("../src/dashboard/usage.js");
}
async function codex() {
  return await import("../src/dashboard/codex-usage.js");
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe("Claude usage snapshot", () => {
  it("reads back what garden writes", async () => {
    const { readUsageSnapshot, writeUsageSnapshot } = await usage();
    const snap = {
      fetchedAt: new Date().toISOString(),
      dataAt: new Date().toISOString(),
      data: {
        fiveHour: { pct: 12, resetsAt: inAnHour() },
        weekly: { pct: 40, resetsAt: inAnHour() },
        scoped: [{ label: "Fable", pct: 3, resetsAt: inAnHour() }, { label: "Opus", pct: 0 }],
        extraUsage: { enabled: true, usedCredits: 2 },
      },
      retryAfterMs: 60_000,
      rateLimitStreak: 1,
      weeklyPctAtScoped: 40,
      // Left by older builds; ignored, not refused.
      sonnet: { pct: 1 },
    };
    writeUsageSnapshot(snap as never);
    expect(readUsageSnapshot()).toEqual(snap);
  });

  it.each([
    ["scoped is a string", { scoped: "x" }],
    ["scoped is an object", { scoped: {} }],
    ["a scoped meter has no label", { scoped: [{ pct: 5 }] }],
    ["a scoped meter's label is empty", { scoped: [{ label: "", pct: 5 }] }],
    ["a scoped meter's percentage is a string", { scoped: [{ label: "Fable", pct: "5" }] }],
    ["a scoped meter's reset time is a number", { scoped: [{ label: "Fable", pct: 5, resetsAt: 4102444800 }] }],
    ["a percentage is a string", { fiveHour: { pct: "100", resetsAt: "2099-01-01T00:00:00Z" } }],
    ["a reset time is a number", { weekly: { pct: 100, resetsAt: 4102444800 } }],
    ["data is an array", []],
    ["extra usage is a string", { extraUsage: "x" }],
    ["extra usage has no enabled flag", { extraUsage: { usedCredits: 2 } }],
    ["the extra-usage limit is a string", { extraUsage: { enabled: true, monthlyLimit: "5000" } }],
    ["the extra-usage credit count is a string", { extraUsage: { enabled: true, usedCredits: "2" } }],
    ["the extra-usage utilization is a string", { extraUsage: { enabled: true, utilization: "25" } }],
  ])("reads a snapshot where %s as absent", async (_label, data) => {
    // Before, these reached the gate and the pane: a string 100 tripped the
    // usage pause by coercion, and a non-array scoped threw.
    const { readUsageSnapshot, USAGE_FILE } = await usage();
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), data }));
    expect(readUsageSnapshot()).toBeNull();
  });

  it.each([
    ["fetchedAt is missing", { fetchedAt: undefined }],
    ["fetchedAt is a number", { fetchedAt: 1 }],
    ["dataAt is a number", { dataAt: 1 }],
    ["the error is an object", { error: { message: "x" } }],
    ["scopedAt is a number", { scopedAt: 1 }],
    ["scopedAttemptedAt is a number", { scopedAttemptedAt: 1 }],
    ["the scoped error is a number", { scopedError: 1 }],
    ["the backoff is not a number", { retryAfterMs: "1e15" }],
    ["the rate-limit streak is a string", { rateLimitStreak: "3" }],
    ["the scoped baseline is a string", { weeklyPctAtScoped: "40" }],
  ])("reads a snapshot whose %s as absent", async (_label, override) => {
    // Each of these reached the pane or the gate by coercion: a numeric dataAt
    // rendered "(stale 9423d)", an object error rendered "([object Object])",
    // and a missing fetchedAt forced an immediate refetch.
    const { readUsageSnapshot, USAGE_FILE } = await usage();
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), ...override }));
    expect(readUsageSnapshot()).toBeNull();
  });

  it("reads a snapshot whose percentage overflows to Infinity as absent", async () => {
    // JSON.parse reads 1e999 as Infinity, which a bare typeof calls a number.
    // 100% is the auto-continue pause threshold, so this one has teeth.
    const { readUsageSnapshot, USAGE_FILE } = await usage();
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(
      USAGE_FILE,
      `{"fetchedAt":"${new Date().toISOString()}","data":{"fiveHour":{"pct":1e999,"resetsAt":"${inAnHour()}"}}}`,
    );
    expect(readUsageSnapshot()).toBeNull();
  });

  it("ignores a snapshot left in the worker-writable sessions dir", async () => {
    // A well-formed 100% reading there paused auto-continue fleet-wide; no
    // type check can tell a forged reading from a real one.
    const { readUsageSnapshot } = await usage();
    fs.writeFileSync(path.join(env.sessionsDir, "claude-usage.json"), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: { fiveHour: { pct: 100, resetsAt: "2099-01-01T00:00:00Z" } },
    }));
    expect(readUsageSnapshot()).toBeNull();
  });

  // The guard's promise is two-sided: it must refuse what garden never writes,
  // and accept everything garden does. A reader that rejects a real snapshot
  // blanks the meter and makes every Stop hook fetch again.
  describe("agrees with its own writer", () => {
    it("keeps an enabled extra-usage bucket that reports no numbers", async () => {
      const { normalizeUsage, writeUsageSnapshot, readUsageSnapshot } = await usage();
      const data = normalizeUsage({
        five_hour: { utilization: 0.05, resets_at: inAnHour() },
        extra_usage: { is_enabled: true, monthly_limit: null, used_credits: null, utilization: null },
      });
      expect(data.extraUsage).toEqual({ enabled: true });
      writeUsageSnapshot({ fetchedAt: new Date().toISOString(), data } as never);
      expect(readUsageSnapshot()?.data?.extraUsage).toEqual({ enabled: true });
    });

    it("drops response fields that overflow instead of writing a snapshot it would refuse", async () => {
      // JSON.stringify writes Infinity back as null, which the reader rightly
      // refuses — so an absurd response field would have taken the good bars
      // down with it until the next clean fetch.
      const { normalizeUsage, writeUsageSnapshot, readUsageSnapshot } = await usage();
      const data = normalizeUsage(JSON.parse(`{
        "five_hour": { "utilization": 0.05, "resets_at": "${inAnHour()}" },
        "limits": [{ "kind": "weekly_scoped", "percent": 1e999, "resets_at": "${inAnHour()}",
                     "scope": { "model": { "display_name": "Fable" } } }],
        "extra_usage": { "is_enabled": true, "monthly_limit": 1e999, "used_credits": 1e999, "utilization": 1e999 }
      }`));
      expect(data.scoped).toBeUndefined();
      expect(data.extraUsage).toEqual({ enabled: true });
      writeUsageSnapshot({ fetchedAt: new Date().toISOString(), data } as never);
      expect(readUsageSnapshot()).not.toBeNull();
    });

    it("drops a header meter whose value overflows once scaled", async () => {
      // The percentage is finite until multiplied by 100, and the reset is
      // finite but outside the Date range, where toISOString throws.
      const { parseUnifiedHeaders } = await usage();
      const parsed = parseUnifiedHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "1e307",
        "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
        "anthropic-ratelimit-unified-7d-utilization": "0.4",
        "anthropic-ratelimit-unified-7d-reset": "1e300",
      });
      expect(parsed.fiveHour).toBeUndefined();
      expect(parsed.weekly).toBeUndefined();
    });
  });

  it("drops a prior scoped value that is not a list when merging", async () => {
    // The merge carried it forward, and the refresh's debug line then called
    // .map on it, after writing it back.
    const { mergeUsageData } = await usage();
    expect(mergeUsageData({}, undefined, { scoped: "x" } as never).scoped).toBeUndefined();
  });
});

describe("Codex usage snapshot", () => {
  it.each([
    ["a window is null", { windows: [null] }],
    ["a window's length is a string", { windows: [{ windowMinutes: "300", usedPercent: 5, resetsAt: 1 }] }],
    ["a window's usage is a string", { windows: [{ windowMinutes: 300, usedPercent: "5", resetsAt: 1 }] }],
    ["a window's reset is a string", { windows: [{ windowMinutes: 300, usedPercent: 5, resetsAt: "1" }] }],
    ["the credit balance is a string", { windows: [], creditBalance: "12" }],
    ["the unlimited flag is a string", { windows: [], creditsUnlimited: "yes" }],
  ])("reads a snapshot where %s as absent", async (_label, data) => {
    const { readCodexUsage, CODEX_USAGE_FILE } = await codex();
    fs.mkdirSync(path.dirname(CODEX_USAGE_FILE), { recursive: true });
    fs.writeFileSync(CODEX_USAGE_FILE, JSON.stringify({ capturedAt: Date.now(), data }));
    expect(readCodexUsage()).toBeNull();
  });

  it("reads back a snapshot garden captured", async () => {
    const { readCodexUsage, CODEX_USAGE_FILE } = await codex();
    const snap = { capturedAt: Date.now(), data: { windows: [{ windowMinutes: 43200, usedPercent: 20, resetsAt: 1_900_000_000 }], creditBalance: 0 } };
    fs.mkdirSync(path.dirname(CODEX_USAGE_FILE), { recursive: true });
    fs.writeFileSync(CODEX_USAGE_FILE, JSON.stringify(snap));
    expect(readCodexUsage()).toEqual(snap);
  });

  it("reads a snapshot whose capture time is not a number as absent", async () => {
    // A string capturedAt dated ahead also held the probe's age gate closed,
    // because `now - "<future>"` coerces negative, so no ambient probe ran.
    const { readCodexUsage, CODEX_USAGE_FILE } = await codex();
    fs.mkdirSync(path.dirname(CODEX_USAGE_FILE), { recursive: true });
    fs.writeFileSync(CODEX_USAGE_FILE, JSON.stringify({ capturedAt: String(Date.now()), data: { windows: [] } }));
    expect(readCodexUsage()).toBeNull();
  });

  it("reads a snapshot whose usage overflows to Infinity as absent", async () => {
    const { readCodexUsage, CODEX_USAGE_FILE } = await codex();
    fs.mkdirSync(path.dirname(CODEX_USAGE_FILE), { recursive: true });
    fs.writeFileSync(
      CODEX_USAGE_FILE,
      `{"capturedAt":${Date.now()},"data":{"windows":[{"windowMinutes":300,"usedPercent":1e999,"resetsAt":1}]}}`,
    );
    expect(readCodexUsage()).toBeNull();
  });

  it.each(["used_percent", "window_minutes", "resets_at"])(
    "skips a rollout window whose %s overflows, keeping the reading garden already had",
    async (field) => {
      // Writing the overflow through would replace a good snapshot with one
      // the reader refuses, and the Codex column would disappear.
      const { parseCodexRateLimits } = await codex();
      const win: Record<string, unknown> = {
        used_percent: 17, window_minutes: 43200, resets_at: 1_900_000_000, [field]: "__INF__",
      };
      const rollout = path.join(env.home, `rollout-${field}.jsonl`);
      fs.writeFileSync(
        rollout,
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: win } } })
          .replace('"__INF__"', "1e999") + "\n",
      );
      expect(parseCodexRateLimits(rollout)).toBeNull();
    },
  );

  it("reads back an unlimited account garden captured with no balance", async () => {
    // fromRateLimits writes creditBalance: null for this account, so a guard
    // that refused null would blank its column and re-arm ambient probes.
    const { parseCodexRateLimits, writeCodexUsage, readCodexUsage } = await codex();
    const rollout = path.join(env.home, "rollout-unlimited.jsonl");
    fs.writeFileSync(rollout, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 17, window_minutes: 43200, resets_at: 1_900_000_000 },
          credits: { has_credits: true, unlimited: true, balance: null },
        },
      },
    }) + "\n");
    const data = parseCodexRateLimits(rollout);
    expect(data?.creditBalance).toBeNull();
    writeCodexUsage(data!);
    expect(readCodexUsage()?.data).toEqual(data);
  });
});
