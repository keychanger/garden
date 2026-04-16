import path from "node:path";
import { loadConfig, expandHome } from "../config.js";
import {
  readKeychainCredential, readPersonalCredential, readFileCredential,
  type CredentialSlot, type ClaudeOAuth,
} from "../dashboard/credentials.js";
import { isTTY } from "../output.js";

export async function auth(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  if (sub === "status") return handleStatus();
  throw new Error(`Unknown subcommand: ${sub}. Usage: garden auth status`);
}

interface ProfileState {
  name: string;
  configDir: string;
  slot: CredentialSlot | null;
}

function handleStatus(): void {
  const personal = readPersonalCredential();
  const personalKeychain = readKeychainCredential();

  const cfg = loadConfig();
  const profiles: ProfileState[] = Object.entries(cfg.claudeProfiles ?? {}).map(
    ([name, p]) => {
      const dir = expandHome(p.configDir);
      return {
        name,
        configDir: dir,
        slot: readFileCredential(path.join(dir, ".credentials.json")),
      };
    },
  );

  const displacedBy = detectDisplacement(personalKeychain, profiles);

  if (!isTTY) {
    console.log(JSON.stringify({
      personal: serializeSlot(personal),
      profiles: Object.fromEntries(profiles.map(p => [
        p.name,
        { configDir: p.configDir, ...serializeSlot(p.slot) },
      ])),
      displacedBy,
    }));
    return;
  }

  printPersonal(personal, displacedBy);
  for (const p of profiles) {
    console.log("");
    printProfile(p);
  }

  console.log("");
  if (displacedBy) {
    console.log(`⚠ Routing broken: keychain holds the '${displacedBy}' token instead of personal.`);
    console.log(`  Run 'garden login' to restore the keychain to your personal account.`);
  } else if (profiles.length > 0) {
    console.log(`✓ Routing intact: keychain ≠ any profile file (each profile has its own token).`);
  }
}

function printPersonal(slot: CredentialSlot | null, displacedBy: string | null): void {
  console.log(`default (personal)`);
  if (!slot) {
    console.log(`  ${pad("(none)")}  ⚠ no credentials found — run 'garden login'`);
    return;
  }
  const marker = displacedBy ? `⚠ token matches profile '${displacedBy}' — keychain displaced` : "✓ present";
  console.log(`  ${pad(slot.source)}  ${marker}  ${expiryLine(slot.oauth)}  token: ${tokenPrefix(slot.oauth)}`);
}

function printProfile(p: ProfileState): void {
  console.log(`${p.name}`);
  console.log(`  ${pad("configDir")}  ${p.configDir}`);
  if (!p.slot) {
    console.log(`  ${pad("file")}       ⚠ missing — run 'garden login ${p.name}'`);
    return;
  }
  console.log(`  ${pad("file")}       ✓ present  ${expiryLine(p.slot.oauth)}  token: ${tokenPrefix(p.slot.oauth)}`);
}

function pad(s: string): string {
  return s.padEnd(10);
}

function tokenPrefix(o: ClaudeOAuth): string {
  return o.accessToken.slice(0, 32) + "…";
}

function expiryLine(o: ClaudeOAuth): string {
  if (typeof o.expiresAt !== "number") return "expiry unknown";
  const ms = o.expiresAt - Date.now();
  if (ms <= 0) return "expired";
  return `expires ${formatDuration(ms)}`;
}

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function detectDisplacement(
  keychain: CredentialSlot | null,
  profiles: ProfileState[],
): string | null {
  if (!keychain) return null;
  for (const p of profiles) {
    if (p.slot && p.slot.oauth.accessToken === keychain.oauth.accessToken) {
      return p.name;
    }
  }
  return null;
}

function serializeSlot(slot: CredentialSlot | null): Record<string, unknown> {
  if (!slot) return { present: false };
  return {
    present: true,
    source: slot.source,
    expiresAt: slot.oauth.expiresAt,
    subscriptionType: slot.oauth.subscriptionType,
    tokenPrefix: tokenPrefix(slot.oauth),
  };
}
