import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readFileCredential,
  readClaudeAccount,
  keychainServiceFor,
  isAccessTokenExpired,
  REFRESH_SKEW_MS,
  refreshOAuthToken,
  type ClaudeOAuth,
} from "../src/dashboard/credentials.js";

// Stands in for `security` so the keychain access tests below can inspect each
// invocation without touching a real keychain.
const exec = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; opts: Record<string, unknown> }>,
  failWrites: false,
}));
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: string[], opts: Record<string, unknown>) => {
      exec.calls.push({ args, opts });
      // The prior entry persistCredential merges into.
      if (args.includes("find-generic-password")) {
        return JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old", expiresAt: 0 }, other: 1 });
      }
      if (exec.failWrites) throw new Error("denied");
      return "";
    },
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cred-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCredFile(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

const validPayload = JSON.stringify({
  claudeAiOauth: {
    accessToken: "tok_abc123def456ghi789jkl012mno345pqr678",
    refreshToken: "rt_xyz",
    expiresAt: Date.now() + 3_600_000,
    subscriptionType: "max_5x",
  },
});

describe("readFileCredential", () => {
  it("returns null for non-existent file", () => {
    expect(readFileCredential(path.join(tmpDir, "nope.json"))).toBeNull();
  });

  it("parses a valid credentials file", () => {
    const p = writeCredFile("cred.json", validPayload);
    const slot = readFileCredential(p);
    expect(slot).not.toBeNull();
    expect(slot!.source).toBe("file");
    expect(slot!.oauth.accessToken).toMatch(/^tok_/);
    expect(slot!.oauth.subscriptionType).toBe("max_5x");
  });

  it("returns null for malformed JSON", () => {
    const p = writeCredFile("bad.json", "not json at all");
    expect(readFileCredential(p)).toBeNull();
  });

  it("returns null when claudeAiOauth is missing", () => {
    const p = writeCredFile("no-oauth.json", JSON.stringify({ other: true }));
    expect(readFileCredential(p)).toBeNull();
  });

  it("returns null when accessToken is empty", () => {
    const p = writeCredFile("empty-tok.json", JSON.stringify({
      claudeAiOauth: { accessToken: "" },
    }));
    expect(readFileCredential(p)).toBeNull();
  });

  it("returns null when accessToken is not a string", () => {
    const p = writeCredFile("bad-tok.json", JSON.stringify({
      claudeAiOauth: { accessToken: 12345 },
    }));
    expect(readFileCredential(p)).toBeNull();
  });
});

describe("keychainServiceFor", () => {
  it("uses the bare service for the default config dir", () => {
    expect(keychainServiceFor()).toBe("Claude Code-credentials");
  });

  it("suffixes the first 8 hex of sha256(configDir), as Claude Code does", () => {
    // Observed in a real Keychain: CLAUDE_CONFIG_DIR=/Users/jic/.claude-imp
    // stores its login under this service, not the shared bare one.
    expect(keychainServiceFor("/Users/jic/.claude-imp")).toBe("Claude Code-credentials-907d7e59");
  });
});

describe("readClaudeAccount", () => {
  it("reads the oauthAccount Claude Code recorded in <configDir>/.claude.json", () => {
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), JSON.stringify({
      numStartups: 3,
      oauthAccount: {
        emailAddress: "me@example.com",
        organizationName: "Example Org",
        organizationUuid: "org-1",
        accountUuid: "acct-1",
      },
    }));
    expect(readClaudeAccount(tmpDir)).toEqual({
      emailAddress: "me@example.com",
      organizationName: "Example Org",
      organizationUuid: "org-1",
    });
  });

  it("returns null when the dir has never logged in", () => {
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), JSON.stringify({ numStartups: 1 }));
    expect(readClaudeAccount(tmpDir)).toBeNull();
    expect(readClaudeAccount(path.join(tmpDir, "missing"))).toBeNull();
  });
});

describe("isAccessTokenExpired", () => {
  const now = Date.parse("2026-05-11T12:00:00Z");

  it("returns false when expiresAt is in the future beyond skew", () => {
    const o: ClaudeOAuth = { accessToken: "t", expiresAt: now + 10 * 60_000 };
    expect(isAccessTokenExpired(o, now)).toBe(false);
  });

  it("returns true when expiresAt is in the past", () => {
    const o: ClaudeOAuth = { accessToken: "t", expiresAt: now - 1000 };
    expect(isAccessTokenExpired(o, now)).toBe(true);
  });

  it("returns true when expiresAt is within REFRESH_SKEW_MS of now", () => {
    const o: ClaudeOAuth = { accessToken: "t", expiresAt: now + REFRESH_SKEW_MS - 1 };
    expect(isAccessTokenExpired(o, now)).toBe(true);
  });

  it("returns false when expiresAt is missing (no basis to expire)", () => {
    const o: ClaudeOAuth = { accessToken: "t" };
    expect(isAccessTokenExpired(o, now)).toBe(false);
  });
});

// ESM spies on node:https are forbidden ("Module namespace is not configurable"),
// so we hoist a vi.mock that replaces `request` with a programmable stub. Each
// test installs its `{status, body}` via setNextResponse() before invoking the SUT.
const nextResponse: { status: number; body: string; sent: string } = { status: 200, body: "{}", sent: "" };
vi.mock("node:https", () => ({
  default: {
    request(_opts: unknown, cb?: (res: unknown) => void) {
      const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
      const res = {
        statusCode: nextResponse.status,
        headers: {},
        on(event: string, fn: (arg?: unknown) => void) {
          (listeners[event] ??= []).push(fn);
          return this;
        },
      };
      const req = {
        on(_event: string, _fn: (arg?: unknown) => void) { return this; },
        write(chunk: string | Buffer) { nextResponse.sent += chunk.toString(); return true; },
        end() {
          queueMicrotask(() => {
            cb?.(res);
            for (const fn of listeners["data"] ?? []) fn(nextResponse.body);
            for (const fn of listeners["end"] ?? []) fn();
          });
        },
        destroy(_err?: Error) {},
      };
      return req;
    },
  },
}));

describe("refreshOAuthToken", () => {
  function setNextResponse(status: number, body: string): void {
    nextResponse.status = status;
    nextResponse.body = body;
    nextResponse.sent = "";
  }

  it("posts the refresh-token grant and returns new tokens on 200", async () => {
    setNextResponse(200, JSON.stringify({
      access_token: "new-at",
      refresh_token: "new-rt",
      expires_in: 3600,
      scope: "user:profile user:inference",
    }));
    const before = Date.now();
    const oauth = await refreshOAuthToken("old-rt");
    expect(oauth.accessToken).toBe("new-at");
    expect(oauth.refreshToken).toBe("new-rt");
    expect(oauth.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100);
    expect(oauth.scopes).toEqual(["user:profile", "user:inference"]);
    const body = JSON.parse(nextResponse.sent);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("old-rt");
    expect(typeof body.client_id).toBe("string");
  });

  it("keeps the old refresh token when the server doesn't rotate it", async () => {
    setNextResponse(200, JSON.stringify({ access_token: "new-at", expires_in: 3600 }));
    const oauth = await refreshOAuthToken("old-rt");
    expect(oauth.refreshToken).toBe("old-rt");
  });

  it("tags invalid_grant errors so callers can surface login_expired", async () => {
    setNextResponse(400, JSON.stringify({ error: "invalid_grant" }));
    await expect(refreshOAuthToken("revoked-rt")).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("tags generic http errors with http_<status>", async () => {
    setNextResponse(503, "service unavailable");
    await expect(refreshOAuthToken("rt")).rejects.toMatchObject({ code: "http_503" });
  });

  it("tags malformed responses so transient backoff applies", async () => {
    setNextResponse(200, "{not json");
    await expect(refreshOAuthToken("rt")).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("tags missing-field responses as malformed", async () => {
    setNextResponse(200, JSON.stringify({ access_token: "x" }));
    await expect(refreshOAuthToken("rt")).rejects.toMatchObject({ code: "malformed_response" });
  });

});

// The keychain entry claude CLI itself reads. The write must hand security
// the whole credential as the `-w` value: its prompted form reads through
// getpass(), which takes /dev/tty when one exists and truncates to 128
// characters, storing a corrupt credential while exiting 0. The read must be
// bounded, since a locked keychain otherwise stalls the usage poller on an
// unlock prompt nothing there can answer.
describe("keychain access", () => {
  const oauth: ClaudeOAuth = {
    accessToken: `sk-ant-oat01-${"A".repeat(100)}`,
    refreshToken: `sk-ant-ort01-${"R".repeat(100)}`,
    expiresAt: 1,
  };
  const writes = () => exec.calls.filter(c => c.args.includes("add-generic-password"));

  beforeEach(() => { exec.calls = []; exec.failWrites = false; });

  it("writes the full merged credential as the -w value, never through a prompt", async () => {
    if (process.platform !== "darwin") return;
    const { persistCredential } = await import("../src/dashboard/credentials.js");
    expect(persistCredential("keychain", oauth)).toBe(true);
    expect(writes()).toHaveLength(1);
    const { args, opts } = writes()[0];
    const value = args[args.indexOf("-w") + 1];
    expect(value).toBeDefined();
    expect(value.length).toBeGreaterThan(128);
    const stored = JSON.parse(value);
    expect(stored.claudeAiOauth.accessToken).toBe(oauth.accessToken);
    expect(stored.claudeAiOauth.refreshToken).toBe(oauth.refreshToken);
    expect(stored.other).toBe(1);
    expect(opts.input).toBeUndefined();
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it("reports failure when the write fails", async () => {
    if (process.platform !== "darwin") return;
    exec.failWrites = true;
    const { persistCredential } = await import("../src/dashboard/credentials.js");
    expect(persistCredential("keychain", oauth)).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("bounds the read so a locked keychain cannot stall the poller", async () => {
    if (process.platform !== "darwin") return;
    const { readKeychainCredential } = await import("../src/dashboard/credentials.js");
    readKeychainCredential();
    const reads = exec.calls.filter(c => c.args.includes("find-generic-password"));
    expect(reads).toHaveLength(1);
    expect(reads[0].opts.timeout).toBeGreaterThan(0);
  });
});
