import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
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
    fs.writeFileSync(path.join(env.sessionsDir, "claude-usage.json"), JSON.stringify(snap));
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
