// The ⌥; garden settings menu: the machine-wide (garden-level, not per-project)
// resource budgets under `limits` in ~/.garden/config.yml (see LimitsConfig in
// config.ts). Sibling of the ⌥, project menu — ⌥, configures one project, ⌥;
// configures the whole garden — so no project is resolved here.
//
// Every row shows the effective value inline, so the menu doubles as the
// inspector. Selecting a value routes through `setLimit` (the same writer the
// `garden limits` CLI uses), then re-opens the menu (form feel). Plan builders
// are pure and tested; the runners resolve config and drive tmux.
import {
  getChecksSlotsOverride,
  getMaxConcurrentReviews,
  setLimit,
  type LimitsConfig,
} from "../config.js";
import { defaultChecksSlots } from "../checks-semaphore.js";
import { resolveGardenRunner } from "./runner.js";
import { tmuxDisplay } from "./tmux.js";
import { runMenu, type MenuSpec, type MenuRow } from "./menu.js";
import { log } from "./log.js";

// Preset values for the submenus. Arbitrary values (and anything outside these)
// stay on the `garden limits` CLI, mirroring how the project menu offers a
// curated model/effort list while the CLI covers exotic ids.
const CHECKS_SLOT_CHOICES = [1, 2, 3, 4, 6, 8];
const MAX_REVIEW_CHOICES = [1, 2, 3, 4, 6, 8];

// The config-key each menu row mutates. Kept explicit (not free-form) so the
// dispatch can reject anything else.
const CHECKS_SLOTS_KEY = "checksSlots";
const MAX_REVIEWS_KEY = "maxConcurrentReviews";

// ---- pure plan builders --------------------------------------------------

export interface GardenMenuView {
  runner: string;
  checksSlots: string; // "N" or "N (hardware default; unset)"
  maxReviews: string;  // "N" or "unlimited (unset)"
}

export function buildGardenMenuPlan(v: GardenMenuView): MenuSpec {
  const g = v.runner;
  const rows: MenuRow[] = [
    { label: `(1) checks slots     ${v.checksSlots}`, key: "1", run: `${g} dashboard _garden-checks-submenu` },
    { label: `(2) max reviews      ${v.maxReviews}`, key: "2", run: `${g} dashboard _garden-reviews-submenu` },
  ];
  return { title: "Garden settings · machine-wide limits", rows };
}

// A numeric-limit submenu: one row per preset (current marked), each dispatching
// `_garden-limit-set <key> <value>`, plus an unset row that clears the override.
export function buildGardenLimitSubmenuPlan(
  key: string, title: string, choices: number[], current: number | undefined, unsetLabel: string, runner: string,
): MenuSpec {
  const rows: MenuRow[] = choices.map((n, i) => ({
    label: n === current ? `${n}  ✓` : String(n),
    key: i < 9 ? String(i + 1) : "",
    run: `${runner} dashboard _garden-limit-set ${key} ${n}`,
  }));
  rows.push({ label: `(0) ${unsetLabel}`, key: "0", run: `${runner} dashboard _garden-limit-set ${key} unset` });
  return { title, rows };
}

export function buildChecksSlotsSubmenuPlan(current: number | undefined, hardwareDefault: number, runner: string): MenuSpec {
  return buildGardenLimitSubmenuPlan(
    CHECKS_SLOTS_KEY,
    `Concurrent checks-suite runs (hardware default: ${hardwareDefault})`,
    CHECKS_SLOT_CHOICES, current, `unset — hardware default (${hardwareDefault})`, runner,
  );
}

export function buildMaxReviewsSubmenuPlan(current: number, runner: string): MenuSpec {
  return buildGardenLimitSubmenuPlan(
    MAX_REVIEWS_KEY,
    "Simultaneous headless reviewers (fleet-wide)",
    // A live current of 0 means "unlimited" — never a checked preset row.
    MAX_REVIEW_CHOICES, current > 0 ? current : undefined, "unset — unlimited", runner,
  );
}

// ---- runners (resolve data, drive tmux) ----------------------------------

function gardenMenuView(): GardenMenuView {
  const override = getChecksSlotsOverride();
  const hw = defaultChecksSlots();
  const maxReviews = getMaxConcurrentReviews();
  return {
    runner: resolveGardenRunner(),
    checksSlots: override !== undefined ? String(override) : `${hw} (hardware default; unset)`,
    maxReviews: maxReviews > 0 ? String(maxReviews) : "unlimited (unset)",
  };
}

export function runGardenMenu(): void {
  runMenu(buildGardenMenuPlan(gardenMenuView()));
}

export function runChecksSlotsSubmenu(): void {
  runMenu(buildChecksSlotsSubmenuPlan(getChecksSlotsOverride(), defaultChecksSlots(), resolveGardenRunner()));
}

export function runMaxReviewsSubmenu(): void {
  runMenu(buildMaxReviewsSubmenuPlan(getMaxConcurrentReviews(), resolveGardenRunner()));
}

// ---- mutating dispatch (set -> present -> re-open) ------------------------

// _garden-limit-set <key> <value>: value "unset"/""/"0" clears the override (0
// reviews would mean "block everything" — never a real intent, so it maps to
// unlimited, matching the CLI). checksSlots has a floor of 1.
export function applyGardenLimitFromMenu(key: string, value: string): void {
  if (key !== CHECKS_SLOTS_KEY && key !== MAX_REVIEWS_KEY) {
    tmuxDisplay(`Cannot set '${key}' from the garden menu.`);
    return;
  }
  const clearing = value === "unset" || value === "" || value === "0";
  try {
    if (clearing) {
      setLimit(key as keyof LimitsConfig, undefined);
      tmuxDisplay(key === CHECKS_SLOTS_KEY ? "Cleared checks slots (hardware default)." : "Cleared max reviews (unlimited).");
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        tmuxDisplay(`Expected a positive integer, got '${value}'.`);
        return;
      }
      setLimit(key as keyof LimitsConfig, n);
      tmuxDisplay(key === CHECKS_SLOTS_KEY ? `Checks slots set to ${n}.` : `Max reviews set to ${n}.`);
    }
  } catch (err) {
    tmuxDisplay(err instanceof Error ? err.message : String(err));
    log.error("garden-menu", "failed to set limit", { data: { key, value, error: String(err) } });
    return;
  }
  runGardenMenu();
}
