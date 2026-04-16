// Helpers for reading and capturing Claude Code OAuth credentials.
//
// On macOS, Claude Code persists credentials to a single Keychain entry
// ("Claude Code-credentials") regardless of CLAUDE_CONFIG_DIR — see the
// claudeProfile design notes in CLAUDE.md. To maintain distinct tokens for
// multiple profiles we capture the Keychain entry to <configDir>/.credentials.json
// after each profile login, then re-login the default account so the Keychain
// holds the personal token again.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Copy the macOS Keychain entry to <credFile> atomically. Returns true on
// success. Used after a profile login to lock in the just-issued token before
// the user re-logs the default account back into the Keychain.
export function captureKeychainTo(credFile: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return false;
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    const tmp = `${credFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, raw, { mode: 0o600 });
    fs.renameSync(tmp, credFile);
    return true;
  } catch {
    return false;
  }
}

// Run `claude /login` interactively. The caller's CLAUDE_CONFIG_DIR is always
// stripped first so this can be invoked from inside a profile-tagged worker
// pane without leaking the worker's profile into the login flow; pass
// `configDir` to opt back in to a specific dir.
export async function runClaudeLogin(configDir?: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("claude", ["/login"], { stdio: "inherit", env });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`claude /login exited with code ${code}`));
    });
    child.on("error", reject);
  });
}
