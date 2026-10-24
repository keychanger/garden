import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTmpHome } from "./helpers.js";

// Replace the credentials module with controllable stubs so we can drive
// resolveCredential through every outcome (env token, fresh slot, refreshed
// slot, invalid_grant, transient network failure) without touching the real
// Keychain. The mock is hoisted so dynamic imports of usage.js below see it.
const mockState = {
  readPersonalCredential: vi.fn<() => unknown>(),
  refreshOAuthToken: vi.fn<(rt: string) => Promise<unknown>>(),
  persistCredential: vi.fn<(...args: unknown[]) => boolean>(),
};
vi.mock("../src/dashboard/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dashboard/credentials.js")>();
  return {
    ...actual,
    readPersonalCredential: () => mockState.readPersonalCredential(),
    refreshOAuthToken: (rt: string) => mockState.refreshOAuthToken(rt),
    persistCredential: (...args: unknown[]) => mockState.persistCredential(...args),
  };
});

// A stand-in for api.anthropic.com, so a refresh can run end to end with no
// network: records each request's path and answers it from `respond`. Only the
// tests below that set an env token ever reach it.
const mockHttps = {
  paths: [] as string[],
  respond: (_path: string): { status: number; headers?: Record<string, string>; body?: string } => ({ status: 500 }),
};
vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events");
  const request = (opts: { path: string }, onResponse: (res: InstanceType<typeof EventEmitter>) => void) =>
    Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => {},
      end: () => {
        mockHttps.paths.push(opts.path);
        const answer = mockHttps.respond(opts.path);
        const res = Object.assign(new EventEmitter(), { statusCode: answer.status, headers: answer.headers ?? {} });
        setImmediate(() => {
          onResponse(res);
          res.emit("data", answer.body ?? "");
          res.emit("end");
        });
      },
    });
  return { default: { request }, request };
});

describe("resolveCredential", () => {
  useTmpHome();

  beforeEach(() => {
    vi.resetModules();
    mockState.readPersonalCredential.mockReset();
    mockState.refreshOAuthToken.mockReset();
    mockState.persistCredential.mockReset();
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  it("returns the env-var token without refreshing when GARDEN_CLAUDE_SESSION_KEY is set", async () => {
    process.env.GARDEN_CLAUDE_SESSION_KEY = "sk-ant-fake-test-token";
    const { resolveCredential } = await import("../src/dashboard/usage.js");
    const out = await resolveCredential();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.cred.source).toBe("env");
      expect(out.cred.token).toBe("sk-ant-fake-test-token");
      expect(out.cred.refreshed).toBe(false);
    }
    expect(mockState.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("returns no_credentials when neither env nor a slot is present", async () => {
    mockState.readPersonalCredential.mockReturnValue(null);
    const { resolveCredential } = await import("../src/dashboard/usage.js");
    const out = await resolveCredential();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("no_credentials");
  });

  it("uses the slot's access token directly when not yet expired", async () => {
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "fresh-at", refreshToken: "rt", expiresAt: Date.now() + 60 * 60_000 },
    });
    const { resolveCredential } = await import("../src/dashboard/usage.js");
    const out = await resolveCredential();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.cred.token).toBe("fresh-at");
      expect(out.cred.refreshed).toBe(false);
    }
    expect(mockState.refreshOAuthToken).not.toHaveBeenCalled();
    expect(mockState.persistCredential).not.toHaveBeenCalled();
  });

  it("refreshes and persists when the access token is expired and a refresh token exists", async () => {
    mockState.readPersonalCredential.mockReturnValue({
      source: "keychain",
      oauth: { accessToken: "stale-at", refreshToken: "rt-1", expiresAt: Date.now() - 60_000 },
    });
    mockState.refreshOAuthToken.mockResolvedValue({
      accessToken: "new-at",
      refreshToken: "rt-2",
      expiresAt: Date.now() + 3600 * 1000,
    });
    mockState.persistCredential.mockReturnValue(true);

    const { resolveCredential } = await import("../src/dashboard/usage.js");
    const out = await resolveCredential();

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.cred.token).toBe("new-at");
      expect(out.cred.refreshed).toBe(true);
      expect(out.cred.source).toBe("keychain");
    }
    expect(mockState.refreshOAuthToken).toHaveBeenCalledWith("rt-1");
    expect(mockState.persistCredential).toHaveBeenCalledWith("keychain", expect.objectContaining({
      accessToken: "new-at",
      refreshToken: "rt-2",
    }));
  });

  it("returns login_expired when the refresh-token grant is rejected as invalid_grant", async () => {
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale-at", refreshToken: "revoked-rt", expiresAt: Date.now() - 1000 },
    });
    const err = new Error("invalid_grant") as Error & { code: string };
    err.code = "invalid_grant";
    mockState.refreshOAuthToken.mockRejectedValue(err);

    const { resolveCredential } = await import("../src/dashboard/usage.js");
    const out = await resolveCredential();

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("login_expired");
    expect(mockState.persistCredential).not.toHaveBeenCalled();
  });

  it("returns refresh_failed for transient errors so the snapshot uses the shorter generic backoff", async () => {
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale-at", refreshToken: "rt", expiresAt: Date.now() - 1000 },
    });
    const err = new Error("timeout") as Error & { code: string };
    err.code = "network";
    mockState.refreshOAuthToken.mockRejectedValue(err);

    const { resolveCredential } = await import("../src/dashboard/usage.js");
    const out = await resolveCredential();

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("refresh_failed");
  });

  it("returns login_expired when the access token is expired but no refresh token exists", async () => {
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale-at", expiresAt: Date.now() - 1000 },
    });
    const { resolveCredential } = await import("../src/dashboard/usage.js");
    const out = await resolveCredential();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("login_expired");
    expect(mockState.refreshOAuthToken).not.toHaveBeenCalled();
  });
});

describe("refreshUsage — login expired path uses the auth backoff", () => {
  useTmpHome();

  beforeEach(() => {
    vi.resetModules();
    mockState.readPersonalCredential.mockReset();
    mockState.refreshOAuthToken.mockReset();
    mockState.persistCredential.mockReset();
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  it("stamps retryAfterMs with AUTH_BACKOFF_MS so decideRefresh sleeps long, preserving prior data", async () => {
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale-at", refreshToken: "revoked-rt", expiresAt: Date.now() - 1000 },
    });
    const err = new Error("invalid_grant") as Error & { code: string };
    err.code = "invalid_grant";
    mockState.refreshOAuthToken.mockRejectedValue(err);

    const { refreshUsage, AUTH_BACKOFF_MS, decideRefresh } = await import("../src/dashboard/usage.js");
    const snap = await refreshUsage();

    expect(snap.error).toBe("login expired");
    expect(snap.retryAfterMs).toBe(AUTH_BACKOFF_MS);
    // decideRefresh treats this snapshot as locked out for the full backoff window.
    const decision = decideRefresh(snap, Date.now(), "poller");
    expect(decision.shouldRefresh).toBe(false);
    expect(decision.nextAttemptInMs).toBeGreaterThanOrEqual(AUTH_BACKOFF_MS - 1000);
  });
});

describe("refreshUsage — force bypasses the auth backoff but not the rate limit", () => {
  const env = useTmpHome();

  beforeEach(() => {
    vi.resetModules();
    mockState.readPersonalCredential.mockReset();
    mockState.refreshOAuthToken.mockReset();
    mockState.persistCredential.mockReset();
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  function seedSnapshot(snap: unknown): void {
    fs.writeFileSync(path.join(env.controlDir, "claude-usage.json"), JSON.stringify(snap));
  }

  it("force re-attempts a 'login expired' snapshot still inside the auth backoff", async () => {
    const now = Date.now();
    // 5 min old: well inside the 30-min auth backoff, so the unforced path holds.
    seedSnapshot({
      fetchedAt: new Date(now - 5 * 60_000).toISOString(),
      error: "login expired",
      retryAfterMs: 30 * 60_000,
    });
    // Drive resolveCredential to a deterministic login_expired (revoked refresh
    // token) so the re-attempt never touches the network.
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale", refreshToken: "revoked", expiresAt: now - 1000 },
    });
    const err = new Error("invalid_grant") as Error & { code: string };
    err.code = "invalid_grant";
    mockState.refreshOAuthToken.mockRejectedValue(err);

    const { refreshUsage } = await import("../src/dashboard/usage.js");

    // Without force the backoff holds: cached snapshot returned, credential untouched.
    const cached = await refreshUsage(false);
    expect(cached.fetchedAt).toBe(new Date(now - 5 * 60_000).toISOString());
    expect(mockState.readPersonalCredential).not.toHaveBeenCalled();

    // With force the gate is bypassed: it re-reads the credential and re-stamps
    // the snapshot, even though this particular attempt also fails.
    const forced = await refreshUsage(true);
    expect(mockState.readPersonalCredential).toHaveBeenCalled();
    expect(forced.fetchedAt).not.toBe(cached.fetchedAt);
    expect(forced.error).toBe("login expired");
  });

  it("force still honors a 'rate-limited' retry-after so it never hammers the endpoint", async () => {
    const now = Date.now();
    seedSnapshot({
      fetchedAt: new Date(now - 30_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 50 * 60_000,
    });

    const { refreshUsage } = await import("../src/dashboard/usage.js");
    const forced = await refreshUsage(true);

    // The rate-limit backoff is the one wait force must respect: no re-fetch,
    // no credential read, cached snapshot returned unchanged.
    expect(forced.fetchedAt).toBe(new Date(now - 30_000).toISOString());
    expect(forced.error).toBe("rate-limited");
    expect(mockState.readPersonalCredential).not.toHaveBeenCalled();
  });
});

// `garden usage refresh` and `garden login` force a refresh. The primary probe
// is generously limited; the scoped (Fable) bar's endpoint is not: it answers a
// 429 with Retry-After: 3600, and its per-token budget is shared with the probe.
describe("refreshUsage — force skips the scoped cadence but not a scoped 429's hold", () => {
  const env = useTmpHome();
  const SCOPED_PATH = "/api/oauth/usage";

  beforeEach(() => {
    vi.resetModules();
    mockHttps.paths.length = 0;
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    mockHttps.respond = (p) => p === SCOPED_PATH
      ? { status: 200, body: JSON.stringify({ five_hour: null, seven_day: null }) }
      : {
          status: 200,
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.4",
            "anthropic-ratelimit-unified-5h-reset": reset,
            "anthropic-ratelimit-unified-7d-utilization": "0.41",
            "anthropic-ratelimit-unified-7d-reset": reset,
          },
        };
    process.env.GARDEN_CLAUDE_SESSION_KEY = "sk-ant-test-token";
  });
  afterEach(() => {
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  // No worker is registered, so the unforced cadence is the 12h idle keepalive.
  function seedScoped429(attemptedAgoMs: number): void {
    const now = Date.now();
    fs.writeFileSync(path.join(env.controlDir, "claude-usage.json"), JSON.stringify({
      fetchedAt: new Date(now - 60 * 60_000).toISOString(),
      data: { scoped: [{ label: "Fable", pct: 30, resetsAt: new Date(now + 86_400_000).toISOString() }] },
      scopedAttemptedAt: new Date(now - attemptedAgoMs).toISOString(),
      scopedError: "rate-limited",
    }));
  }

  it("refreshes the primary bars but holds the scoped endpoint inside a 429's hour", async () => {
    seedScoped429(5 * 60_000);
    const { refreshUsage } = await import("../src/dashboard/usage.js");

    const snap = await refreshUsage(true);

    expect(mockHttps.paths).toEqual(["/v1/messages"]);
    expect(snap.data?.weekly?.pct).toBe(41);
    expect(snap.scopedError).toBe("rate-limited");
  });

  it("still lets a forced refresh past the idle cadence once that hour is up", async () => {
    seedScoped429(61 * 60_000);
    const { refreshUsage } = await import("../src/dashboard/usage.js");

    const snap = await refreshUsage(true);

    expect(mockHttps.paths).toEqual(["/v1/messages", SCOPED_PATH]);
    expect(snap.scopedError).toBeUndefined();
  });
});

// While a refresh fetches, every other process reads its claim. The claim used
// to drop both endpoints' error state, so a forced refresh landing mid-fetch
// saw no 429 hold on either one.
describe("refreshUsage — the claim keeps both endpoints' holds", () => {
  const env = useTmpHome();

  beforeEach(() => {
    vi.resetModules();
    mockState.readPersonalCredential.mockReset();
    mockState.refreshOAuthToken.mockReset();
    mockState.persistCredential.mockReset();
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  it("carries the prior error, backoff, streak and scoped 429 while its fetch is in flight", async () => {
    const now = Date.now();
    // A primary 429 whose backoff has run out, so this unforced refresh claims.
    fs.writeFileSync(path.join(env.controlDir, "claude-usage.json"), JSON.stringify({
      fetchedAt: new Date(now - 30 * 60_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 10 * 60_000,
      rateLimitStreak: 2,
      scopedAttemptedAt: new Date(now - 5 * 60_000).toISOString(),
      scopedError: "rate-limited",
    }));
    // Hold the fetch at its token refresh, so the claim can be read mid-flight.
    let fail!: (err: Error) => void;
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale", refreshToken: "rt", expiresAt: now - 1000 },
    });
    mockState.refreshOAuthToken.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));

    const { refreshUsage, readUsageSnapshot } = await import("../src/dashboard/usage.js");
    const inFlight = refreshUsage();
    await vi.waitFor(() => expect(mockState.refreshOAuthToken).toHaveBeenCalled());

    const claim = readUsageSnapshot();
    expect(claim?.claimedAt).toBe(claim?.fetchedAt);
    expect(claim).toMatchObject({
      error: "rate-limited",
      retryAfterMs: 10 * 60_000,
      rateLimitStreak: 2,
      scopedError: "rate-limited",
    });

    fail(Object.assign(new Error("timeout"), { code: "network" }));
    const landed = await inFlight;
    expect(landed.claimedAt).toBeUndefined();
    expect(readUsageSnapshot()?.claimedAt).toBeUndefined();
  });
});

// A forced refresh skips the cadence check that keeps every other caller off a
// claim, so it used to fetch beside another process's refresh: a second scoped
// request, and whichever final write came last discarded the other's outcome.
describe("refreshUsage — a forced refresh waits out a fetch in flight", () => {
  const env = useTmpHome();
  const SCOPED_PATH = "/api/oauth/usage";
  const reset = new Date(Date.now() + 86_400_000).toISOString();

  beforeEach(() => {
    vi.resetModules();
    mockHttps.paths.length = 0;
    const resetSec = String(Math.floor(Date.now() / 1000) + 3600);
    mockHttps.respond = (p) => p === SCOPED_PATH
      ? { status: 200, body: JSON.stringify({ five_hour: null, seven_day: null }) }
      : {
          status: 200,
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.4",
            "anthropic-ratelimit-unified-5h-reset": resetSec,
            "anthropic-ratelimit-unified-7d-utilization": "0.41",
            "anthropic-ratelimit-unified-7d-reset": resetSec,
          },
        };
    process.env.GARDEN_CLAUDE_SESSION_KEY = "sk-ant-test-token";
  });
  afterEach(() => {
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  function writeSnapshot(snap: unknown): void {
    fs.writeFileSync(path.join(env.controlDir, "claude-usage.json"), JSON.stringify(snap));
  }

  it("sends nothing while another process's claim is in flight, then refreshes on what it wrote", async () => {
    const claimedAt = new Date().toISOString();
    writeSnapshot({ fetchedAt: claimedAt, claimedAt, data: { weekly: { pct: 30, resetsAt: reset } } });
    const { refreshUsage } = await import("../src/dashboard/usage.js");

    const forced = refreshUsage(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockHttps.paths).toEqual([]);

    // The other process's fetch lands, having just met a scoped 429.
    const landedAt = new Date().toISOString();
    writeSnapshot({
      fetchedAt: landedAt,
      data: { weekly: { pct: 35, resetsAt: reset } },
      scopedAttemptedAt: landedAt,
      scopedError: "rate-limited",
    });
    const snap = await forced;

    expect(mockHttps.paths).toEqual(["/v1/messages"]);
    expect(snap.data?.weekly?.pct).toBe(41);
    expect(snap.scopedError).toBe("rate-limited");
  });

  it("does not wait on a claim older than any refresh takes", async () => {
    const { refreshUsage, CLAIM_IN_FLIGHT_MS } = await import("../src/dashboard/usage.js");
    const claimedAt = new Date(Date.now() - CLAIM_IN_FLIGHT_MS - 1000).toISOString();
    writeSnapshot({ fetchedAt: claimedAt, claimedAt });

    await refreshUsage(true);

    expect(mockHttps.paths).toEqual(["/v1/messages", SCOPED_PATH]);
  });
});

describe("refreshUsage — the claim honors the caller's cadence class", () => {
  const env = useTmpHome();

  beforeEach(() => {
    vi.resetModules();
    mockState.readPersonalCredential.mockReset();
    mockState.refreshOAuthToken.mockReset();
    mockState.persistCredential.mockReset();
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  function seedSnapshot(snap: unknown): void {
    fs.writeFileSync(path.join(env.controlDir, "claude-usage.json"), JSON.stringify(snap));
  }

  it("hook path fetches a snapshot the poller leaves alone", async () => {
    const usage = await import("../src/dashboard/usage.js");
    // Aged past the hook's demand cooldown but inside the poller's idle
    // cadence — turn-end is what keeps the meter fresh between poller ticks,
    // so the hook claims here while a healthy loop stays on its own clock.
    const age = (usage.POLL_OK_MS + usage.HOOK_REFRESH_COOLDOWN_MS) / 2;
    const fetchedAt = new Date(Date.now() - age).toISOString();
    seedSnapshot({ fetchedAt, data: {} });
    // no_credentials short-circuits before any network call; the attempt is
    // still observable via readPersonalCredential and the rewritten snapshot.
    mockState.readPersonalCredential.mockReturnValue(null);

    const pollerSnap = await usage.refreshUsage(false, "poller");
    expect(pollerSnap.fetchedAt).toBe(fetchedAt);
    expect(mockState.readPersonalCredential).not.toHaveBeenCalled();

    const hookSnap = await usage.refreshUsage();
    expect(mockState.readPersonalCredential).toHaveBeenCalled();
    expect(hookSnap.fetchedAt).not.toBe(fetchedAt);
    expect(hookSnap.error).toBe("no Claude Code credentials found");
  });
});

describe("refreshUsage — transition-graded logging collapses repeated failures", () => {
  const env = useTmpHome();

  beforeEach(() => {
    vi.resetModules();
    mockState.readPersonalCredential.mockReset();
    mockState.refreshOAuthToken.mockReset();
    mockState.persistCredential.mockReset();
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
    delete process.env.GARDEN_LOG_LEVEL; // keep the default (info) so debug lines stay suppressed
  });

  function seedSnapshot(snap: unknown): void {
    fs.writeFileSync(path.join(env.controlDir, "claude-usage.json"), JSON.stringify(snap));
  }

  // The operator-visible surface: usage lines that reach the default info-level
  // log. A downgraded (debug) repeat is absent from this list by construction.
  function usageLogEntries(): { level: string; msg: string }[] {
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.src === "usage")
      .map((e) => ({ level: e.level, msg: e.msg }));
  }

  // Drive resolveCredential to a deterministic transient (network) refresh
  // failure — the 'offline' outcome, without touching the real network.
  function mockTransientRefreshFailure(): void {
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale", refreshToken: "rt", expiresAt: Date.now() - 1000 },
    });
    const err = new Error("timeout") as Error & { code: string };
    err.code = "network";
    mockState.refreshOAuthToken.mockRejectedValue(err);
  }

  it("logs only the first of three identical transient failures at info; the repeats drop to debug", async () => {
    mockTransientRefreshFailure();
    const { refreshUsage } = await import("../src/dashboard/usage.js");

    // force bypasses the generic-error backoff so all three attempts actually run.
    await refreshUsage(true);
    await refreshUsage(true);
    await refreshUsage(true);

    // Three failures, one visible line — the overnight-offline collapse.
    expect(usageLogEntries()).toEqual([{ level: "info", msg: "token refresh failed" }]);
  });

  it("keeps an actionable auth failure at warn even mid-offline-stretch", async () => {
    // Prior snapshot is a stale offline (transient) error, aged past the generic backoff.
    seedSnapshot({
      fetchedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      error: "getaddrinfo ENOTFOUND",
    });
    // This attempt fails with a revoked refresh token → actionable "login expired".
    mockState.readPersonalCredential.mockReturnValue({
      source: "file",
      oauth: { accessToken: "stale", refreshToken: "revoked", expiresAt: Date.now() - 1000 },
    });
    const err = new Error("invalid_grant") as Error & { code: string };
    err.code = "invalid_grant";
    mockState.refreshOAuthToken.mockRejectedValue(err);

    const { refreshUsage } = await import("../src/dashboard/usage.js");
    await refreshUsage();

    // transient → auth is a new, actionable condition: it surfaces at warn, not
    // buried at debug like an offline repeat would be.
    expect(usageLogEntries()).toContainEqual({ level: "warn", msg: "login expired" });
  });
});
