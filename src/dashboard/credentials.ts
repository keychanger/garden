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

// Fingerprints the current OAuth credential so we can detect when /login writes
// a new one. macOS stores in the shared Keychain regardless of CLAUDE_CONFIG_DIR;
// Linux stores per-config-dir on disk.
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
// `claude /login` drops into the REPL after success; we poll the credential
// store and send SIGTERM once it updates so the caller returns to shell.
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
