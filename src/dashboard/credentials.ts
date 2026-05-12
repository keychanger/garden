import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";

// Public OAuth refresh endpoint + client_id used by Claude Code itself
// (extracted from the binary). Matches what `claude /login` provisions, so
// rotating the refresh token here stays compatible with claude CLI's own
// refresh path.
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Treat the access token as expired this many ms before its stated `expiresAt`
// so a near-boundary fetch doesn't race the server's own clock skew.
export const REFRESH_SKEW_MS = 60 * 1000;

export interface ClaudeOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;          // unix ms
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface CredentialSlot {
  source: "keychain" | "file";
  oauth: ClaudeOAuth;
}

export function readKeychainCredential(): CredentialSlot | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const oauth = parseOAuth(raw);
    return oauth ? { source: "keychain", oauth } : null;
  } catch {
    return null;
  }
}

export function readFileCredential(filePath: string): CredentialSlot | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const oauth = parseOAuth(fs.readFileSync(filePath, "utf8"));
    return oauth ? { source: "file", oauth } : null;
  } catch {
    return null;
  }
}

export function readPersonalCredential(): CredentialSlot | null {
  return (
    readKeychainCredential() ??
    readFileCredential(path.join(os.homedir(), ".claude", ".credentials.json"))
  );
}

function parseOAuth(raw: string): ClaudeOAuth | null {
  try {
    const parsed = JSON.parse(raw);
    const o = parsed?.claudeAiOauth;
    if (!o || typeof o.accessToken !== "string" || o.accessToken.length === 0) {
      return null;
    }
    return o as ClaudeOAuth;
  } catch {
    return null;
  }
}

// True when the access token has expired (or is within REFRESH_SKEW_MS of
// expiring). Snapshots without an `expiresAt` field are treated as fresh —
// we have no basis to expire them and the API will surface 401 if wrong.
export function isAccessTokenExpired(oauth: ClaudeOAuth, nowMs: number = Date.now()): boolean {
  if (typeof oauth.expiresAt !== "number") return false;
  return oauth.expiresAt - REFRESH_SKEW_MS <= nowMs;
}

export interface RefreshError extends Error {
  code: "invalid_grant" | "malformed_response" | "network" | string;
}

// Exchanges the refresh token for a new access token against the public
// OAuth endpoint Claude Code uses. Returns a complete ClaudeOAuth blob with
// the new tokens and computed `expiresAt`. The server may rotate the
// refresh token; when it does, the rotated value is in the returned object
// and the caller must persist it back to the credential source so claude
// CLI's next refresh doesn't fail with invalid_grant on a now-revoked RT.
//
// Throws an Error with `.code = "invalid_grant"` when the refresh token is
// revoked — that's the only non-transient failure (operator must re-login).
// Other failures are tagged `network`, `malformed_response`, or `http_<n>`
// and should be treated as transient (caller falls through, next attempt
// retries from the existing credential).
export function refreshOAuthToken(refreshToken: string): Promise<ClaudeOAuth> {
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const url = new URL(OAUTH_TOKEN_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: url.host,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "garden-dashboard/1.0",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      timeout: 15000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status === 200) {
          let parsed: unknown;
          try { parsed = JSON.parse(buf); }
          catch (e) { return reject(makeRefreshError("malformed_response", `parse: ${(e as Error).message}`)); }
          const p = parsed as Record<string, unknown>;
          const access = p.access_token;
          const expiresIn = p.expires_in;
          if (typeof access !== "string" || typeof expiresIn !== "number") {
            return reject(makeRefreshError("malformed_response", "missing access_token or expires_in"));
          }
          const nextRefresh = typeof p.refresh_token === "string" ? p.refresh_token : refreshToken;
          const scopes = typeof p.scope === "string" ? p.scope.split(" ").filter(Boolean) : undefined;
          resolve({
            accessToken: access,
            refreshToken: nextRefresh,
            expiresAt: Date.now() + expiresIn * 1000,
            ...(scopes ? { scopes } : {}),
          });
          return;
        }
        // invalid_grant is the only non-transient failure — caller surfaces "login expired".
        let serverError: string | undefined;
        try { serverError = (JSON.parse(buf) as { error?: string }).error; } catch { /* non-JSON body */ }
        if (serverError === "invalid_grant") {
          return reject(makeRefreshError("invalid_grant", `${status} invalid_grant`));
        }
        reject(makeRefreshError(`http_${status}`, `${status}: ${buf.slice(0, 200)}`));
      });
    });
    req.on("timeout", () => { req.destroy(makeRefreshError("network", "timeout")); });
    req.on("error", (err) => { reject(makeRefreshError("network", err.message)); });
    req.write(body);
    req.end();
  });
}

function makeRefreshError(code: string, message: string): RefreshError {
  const err = new Error(message) as RefreshError;
  err.code = code;
  return err;
}

// Writes a refreshed oauth blob back to its source so claude CLI's next
// read sees the same tokens we just rotated. Preserves any non-oauth
// top-level fields by merging into the prior raw JSON. Best-effort: on
// failure we log and return false; the next poll will refresh again from
// whatever state the source actually has.
export function persistCredential(source: "keychain" | "file", oauth: ClaudeOAuth): boolean {
  const merged = mergeCredentialPayload(source, oauth);
  if (merged === null) return false;
  if (source === "keychain") {
    if (process.platform !== "darwin") return false;
    const user = os.userInfo().username;
    try {
      execFileSync(
        "security",
        [
          "add-generic-password",
          "-U", "-a", user,
          "-s", "Claude Code-credentials",
          "-w", merged,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      return true;
    } catch (err) {
      log.warn("usage", "keychain writeback failed", { data: { error: (err as Error).message.slice(0, 120) } });
      return false;
    }
  }
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    atomicWriteFile(file, merged, { mode: 0o600 });
    return true;
  } catch (err) {
    log.warn("usage", "credentials file writeback failed", { data: { error: (err as Error).message.slice(0, 120) } });
    return false;
  }
}

function mergeCredentialPayload(source: "keychain" | "file", oauth: ClaudeOAuth): string | null {
  let raw: string;
  if (source === "keychain") {
    if (process.platform !== "darwin") return null;
    try {
      raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch { return null; }
  } else {
    const file = path.join(os.homedir(), ".claude", ".credentials.json");
    try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  }
  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(raw);
    parsed = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  } catch { return null; }
  const priorOAuth = (parsed.claudeAiOauth ?? {}) as Record<string, unknown>;
  parsed.claudeAiOauth = {
    ...priorOAuth,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    ...(oauth.scopes ? { scopes: oauth.scopes } : {}),
  };
  return JSON.stringify(parsed);
}

export function captureKeychainTo(credFile: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return false;
    atomicWriteFile(credFile, raw, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Detects /login writes. macOS: shared Keychain (ignores CLAUDE_CONFIG_DIR); Linux: per-config-dir file.
function credentialFingerprint(configDir?: string): string {
  if (process.platform === "darwin") {
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      return "";
    }
  }
  const dir = configDir ?? path.join(os.homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

// Strips inherited CLAUDE_CONFIG_DIR so profile-tagged panes don't leak.
// `claude /login` drops into REPL after success; poll credentials and SIGTERM on change.
export async function runClaudeLogin(configDir?: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

  const initial = credentialFingerprint(configDir);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("claude", ["/login"], { stdio: "inherit", env });

    let succeeded = false;
    const poll = setInterval(() => {
      const current = credentialFingerprint(configDir);
      if (current && current !== initial) {
        succeeded = true;
        clearInterval(poll);
        // Let claude render "Login successful" before killing.
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
              }
            }, 3000);
          }
        }, 1000);
      }
    }, 500);

    child.on("close", (code) => {
      clearInterval(poll);
      if (succeeded || code === 0) resolve();
      else reject(new Error(`claude /login exited with code ${code}`));
    });
    child.on("error", (err) => {
      clearInterval(poll);
      reject(err);
    });
  });
}
