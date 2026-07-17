// `garden limits`: view or set the machine-wide (garden-level) resource
// budgets in ~/.garden/config.yml under `limits` (see LimitsConfig in
// config.ts). These are not per-project — the workstation is one shared
// resource, so a single knob governs how much of it the whole fleet may use.
import {
  getChecksSlotsOverride,
  getMaxConcurrentReviews,
  loadConfig,
  setLimit,
} from "../config.js";
import { defaultChecksSlots } from "../checks-semaphore.js";
import { output } from "../output.js";

function parsePositiveInt(raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`expected an integer >= ${min}, got '${raw}'`);
  }
  return n;
}

const CLEAR_TOKENS = new Set(["", "unset", "null", "default", "auto"]);

export async function limits(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "status") return showStatus();

  if (sub === "checks-slots") {
    const raw = args[1];
    if (raw === undefined) throw new Error("Usage: garden limits checks-slots <N|unset>");
    if (CLEAR_TOKENS.has(raw)) {
      setLimit("checksSlots", undefined);
      console.log(`Cleared checks-slots (using the hardware default: ${defaultChecksSlots()}).`);
      return;
    }
    const n = parsePositiveInt(raw, 1);
    setLimit("checksSlots", n);
    console.log(`checks-slots set to ${n} (concurrent checks-suite runs on this machine).`);
    return;
  }

  if (sub === "max-reviews") {
    const raw = args[1];
    if (raw === undefined) throw new Error("Usage: garden limits max-reviews <N|unset>  (0 or unset = unlimited)");
    if (CLEAR_TOKENS.has(raw)) {
      setLimit("maxConcurrentReviews", undefined);
      console.log("Cleared max-reviews (unlimited).");
      return;
    }
    const n = parsePositiveInt(raw, 0);
    setLimit("maxConcurrentReviews", n === 0 ? undefined : n);
    console.log(
      n === 0
        ? "max-reviews set to unlimited."
        : `max-reviews set to ${n} (fleet-wide simultaneous headless reviewers).`,
    );
    return;
  }

  throw new Error(
    `Unknown subcommand: ${sub}. `
    + "Usage: garden limits [status | checks-slots <N|unset> | max-reviews <N|unset>]",
  );
}

function showStatus(): void {
  const cfg = loadConfig();
  const checksOverride = getChecksSlotsOverride(cfg);
  const hwDefault = defaultChecksSlots();
  const maxReviews = getMaxConcurrentReviews(cfg);

  output(
    {
      checksSlots: checksOverride ?? null,
      checksSlotsEffective: checksOverride ?? hwDefault,
      maxConcurrentReviews: maxReviews === 0 ? null : maxReviews,
    },
    () => {
      const checksLine = checksOverride !== undefined
        ? `checks-slots:  ${checksOverride}`
        : `checks-slots:  ${hwDefault} (hardware default; unset)`;
      const reviewsLine = maxReviews === 0
        ? "max-reviews:   unlimited (unset)"
        : `max-reviews:   ${maxReviews}`;
      return [checksLine, reviewsLine].join("\n");
    },
  );
}
