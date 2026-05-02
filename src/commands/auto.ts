// `garden auto`: manage the post-merge auto-continue gate.
//
//   garden auto                       # status
//   garden auto on                     # enable (clears any paused metadata)
//   garden auto off                    # disable manually
//   garden auto threshold <N>          # set usage threshold percent (1-100)
//   garden auto resume-on-reset on|off # toggle automatic re-enable after window reset
import {
  getAutoContinueConfig,
  setAutoContinueConfig,
  type AutoContinueConfig,
} from "../config.js";
import { readUsageSnapshot } from "../dashboard/usage.js";
import { output } from "../output.js";

export async function auto(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "status") return showStatus();

  if (sub === "on") {
    const cfg = setAutoContinueConfig({
      enabled: true,
      pausedUntil: undefined,
      pausedReason: undefined,
    });
    console.log(formatBriefStatus(cfg, "enabled"));
    return;
  }

  if (sub === "off") {
    const cfg = setAutoContinueConfig({
      enabled: false,
      pausedUntil: undefined,
      pausedReason: undefined,
    });
    console.log(formatBriefStatus(cfg, "disabled"));
    return;
  }

  if (sub === "threshold") {
    const raw = args[1];
    if (!raw) throw new Error("Usage: garden auto threshold <N>  (1-100)");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      throw new Error(`Threshold must be a number 1-100, got '${raw}'`);
    }
    const cfg = setAutoContinueConfig({ usageThreshold: n });
    console.log(`Threshold set to ${cfg.usageThreshold}%.`);
    return;
  }

  if (sub === "resume-on-reset") {
    const flag = args[1];
    if (flag !== "on" && flag !== "off") {
      throw new Error("Usage: garden auto resume-on-reset on|off");
    }
    const cfg = setAutoContinueConfig({ resumeAfterReset: flag === "on" });
    console.log(`Resume-after-reset is ${cfg.resumeAfterReset ? "on" : "off"}.`);
    return;
  }

  throw new Error(
    `Unknown subcommand: ${sub}. `
    + `Usage: garden auto [on|off|status|threshold <N>|resume-on-reset on|off]`,
  );
}

function showStatus(): void {
  const cfg = getAutoContinueConfig();
  const snap = readUsageSnapshot();
  const meters = {
    fiveHour: snap?.data?.fiveHour?.pct,
    weekly: snap?.data?.weekly?.pct,
  };
  output(
    { ...cfg, meters },
    () => formatStatusPretty(cfg, meters),
  );
}

function formatStatusPretty(
  cfg: AutoContinueConfig,
  meters: { fiveHour?: number; weekly?: number },
): string {
  const lines: string[] = [];
  lines.push(`auto-continue: ${cfg.enabled ? "enabled" : "disabled"}`);
  lines.push(`threshold:     ${cfg.usageThreshold}% (5h, week — sonnet ignored)`);
  lines.push(`resume on reset: ${cfg.resumeAfterReset ? "on" : "off"}`);
  if (!cfg.enabled && cfg.pausedReason) {
    lines.push(`paused reason: ${cfg.pausedReason}`);
  }
  if (!cfg.enabled && cfg.pausedUntil) {
    lines.push(`paused until:  ${cfg.pausedUntil}`);
  }
  const meterLine = [
    meters.fiveHour !== undefined ? `5h ${Math.round(meters.fiveHour)}%` : "5h —",
    meters.weekly   !== undefined ? `week ${Math.round(meters.weekly)}%` : "week —",
  ].join("  ");
  lines.push(`current usage: ${meterLine}`);
  return lines.join("\n");
}

function formatBriefStatus(cfg: AutoContinueConfig, verb: string): string {
  const tail = cfg.resumeAfterReset && verb === "disabled"
    ? " (resume-on-reset is on, but a manual disable does not auto-resume)"
    : "";
  return `Auto-continue ${verb}.${tail}`;
}
