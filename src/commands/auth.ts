import { loadConfig, expandHome } from "../config.js";
import {
  readPersonalCredential, readProfileCredential, readClaudeAccount,
  type CredentialSlot, type ClaudeOAuth, type ClaudeAccount,
} from "../dashboard/credentials.js";
import { providerTokenPresence, syncProviderTokenToVault } from "../dashboard/claude-env.js";
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
  account: ClaudeAccount | null;
  projects: string[];
  sameAccountAsPersonal: boolean;
}

function handleStatus(): void {
  const personal = readPersonalCredential();
  const personalAccount = readClaudeAccount();

  const cfg = loadConfig();
  const profiles: ProfileState[] = Object.entries(cfg.claudeProfiles ?? {}).map(
    ([name, p]) => {
      const dir = expandHome(p.configDir);
      const account = readClaudeAccount(dir);
      return {
        name,
        configDir: dir,
        slot: readProfileCredential(dir),
        account,
        projects: Object.entries(cfg.projects)
          .filter(([, project]) => project.claudeProfile === name)
          .map(([projectName]) => projectName),
        sameAccountAsPersonal: sameOrganization(account, personalAccount),
      };
    },
  );

  // Providers are API-key-backed: no expiry, no Keychain, no account
  // identity. Presence is reported for both the hidden tmux launch vault
  // and this shell — they diverge when the
  // key was exported after the dashboard started, which is exactly the
  // failure an operator would be here to debug.
  const providers = Object.entries(cfg.providers ?? {}).map(([name, p]) => {
    const resolved = { ...p, name, label: p.label ?? name };
    // Heal-on-read: this command runs in the operator's shell, which is
    // exactly where a freshly exported key lives — push it into the
    // hidden launch vault before reporting, so "run auth status" is both the fix
    // and the verification.
    syncProviderTokenToVault(resolved);
    const presence = providerTokenPresence(resolved);
    return { name, authTokenEnv: p.authTokenEnv, ...presence };
  });

  if (!isTTY) {
    console.log(JSON.stringify({
      personal: { ...serializeSlot(personal), account: personalAccount },
      profiles: Object.fromEntries(profiles.map(p => [
        p.name,
        {
          configDir: p.configDir,
          ...serializeSlot(p.slot),
          account: p.account,
          projects: p.projects,
          sameAccountAsPersonal: p.sameAccountAsPersonal,
        },
      ])),
      providers: Object.fromEntries(providers.map(p => [
        p.name,
        { authTokenEnv: p.authTokenEnv, shell: p.shell, session: p.session },
      ])),
    }));
    return;
  }

  printPersonal(personal, personalAccount);
  for (const p of profiles) {
    console.log("");
    printProfile(p);
  }
  for (const p of providers) {
    console.log("");
    console.log(`${p.name} (provider)`);
    const sessionText = p.session === null
      ? "no dashboard running"
      : p.session
        ? "✓ in scoped worker vault"
        : "⚠ NOT in worker vault — provider workers cannot launch";
    const shellText = p.shell ? "✓ in this shell" : "⚠ not in this shell";
    console.log(`  ${pad(p.authTokenEnv)}  ${sessionText}; ${shellText}`);
    if (!p.shell && p.session !== true) {
      console.log(`  ${pad("")}  export ${p.authTokenEnv}, then re-run 'garden auth status' to sync and verify`);
    }
  }

  const shared = profiles.filter(p => p.sameAccountAsPersonal);
  console.log("");
  for (const p of shared) {
    console.log(`⚠ '${p.name}' is logged into your personal account, so its projects use your personal plan.`);
    console.log(`  Sign your browser into the '${p.name}' account, then run 'garden login ${p.name}'.`);
  }
  if (shared.length === 0 && profiles.length > 0) {
    console.log(`✓ Each profile is logged into an account other than personal.`);
  }
}

function printPersonal(slot: CredentialSlot | null, account: ClaudeAccount | null): void {
  console.log(`default (personal)`);
  if (!slot) {
    console.log(`  ${pad("(none)")}  ⚠ no credentials found — run 'garden login'`);
    return;
  }
  console.log(`  ${pad(slot.source)}  ✓ present  ${expiryLine(slot.oauth)}  token: ${tokenPrefix(slot.oauth)}`);
  console.log(`  ${pad("account")}  ${accountLine(account)}`);
}

function printProfile(p: ProfileState): void {
  console.log(`${p.name}`);
  console.log(`  ${pad("configDir")}  ${p.configDir}`);
  console.log(`  ${pad("projects")}  ${p.projects.length > 0 ? p.projects.join(", ") : "(none)"}`);
  if (!p.slot) {
    console.log(`  ${pad("(none)")}  ⚠ no credentials found — run 'garden login ${p.name}'`);
    return;
  }
  console.log(`  ${pad(p.slot.source)}  ✓ present  ${expiryLine(p.slot.oauth)}  token: ${tokenPrefix(p.slot.oauth)}`);
  const marker = p.sameAccountAsPersonal ? "  ⚠ same account as personal" : "";
  console.log(`  ${pad("account")}  ${accountLine(p.account)}${marker}`);
}

function accountLine(account: ClaudeAccount | null): string {
  if (!account?.emailAddress) return "unknown (no oauthAccount recorded)";
  return account.organizationName
    ? `${account.emailAddress} (${account.organizationName})`
    : account.emailAddress;
}

function sameOrganization(a: ClaudeAccount | null, b: ClaudeAccount | null): boolean {
  return !!a?.organizationUuid && a.organizationUuid === b?.organizationUuid;
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
