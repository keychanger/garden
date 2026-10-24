// Shared flag parsing for the commands that spawn a worker or set how one
// launches: `garden workers new` / `grow`, `garden handoff`, and `garden crew
// add` / `edit`. One parser and one effort vocabulary, so the sandboxed handoff
// path cannot drift from the direct one and a flag added to one command is
// held to the same rules as the rest. handoff.ts runs in a worker pane, so
// nothing here reads a file: the effort names come from the per-harness lists
// in dashboard/harness/vocabulary.ts, and the caller names the harness.
import { workerEffortRungs } from "../dashboard/harness/vocabulary.js";

// The options a command takes, spelled as typed.
export interface FlagTable {
  /** Options that take a value: "--model", "-m". */
  readonly values: readonly string[];
  /** Options that take none. */
  readonly switches?: readonly string[];
  /** Value options taken verbatim, for free text that may read like an option. */
  readonly opaque?: readonly string[];
  /** Whether bare arguments are allowed (the caller checks how many). */
  readonly positional?: boolean;
  /** The options as the refusal of an unknown one lists them; the bare names otherwise. */
  readonly usage?: string;
  /** Per-option refusal of a missing value, where the bare one would not say what is wanted. */
  readonly missing?: Readonly<Record<string, string>>;
}

// Splits `args` against a command's option table. Each option is accepted once:
// a misspelled or repeated one is refused rather than stored and never read,
// which spawned workers on the default the flag was meant to override. A value
// that is missing, blank, or starts with a dash is refused too, so `--model
// --effort high` cannot take `--effort` as the model; only an opaque option's
// value is kept exactly as given. Other values are trimmed.
export function parseFlags(
  args: readonly string[], table: FlagTable,
): { positional: string[]; flags: Map<string, string> } {
  const switches = table.switches ?? [];
  const refuse = (option: string): Error => new Error(
    `Unknown or repeated option '${option}'. Supported once each: `
    + `${table.usage ?? [...switches, ...table.values].join(", ")}.`,
  );
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const takesValue = table.values.includes(token);
    if (!takesValue && !switches.includes(token)) {
      if (!table.positional || token.startsWith("--")) throw refuse(token);
      positional.push(token);
      continue;
    }
    if (flags.has(token)) throw refuse(token);
    if (!takesValue) {
      flags.set(token, "");
      continue;
    }
    const opaque = table.opaque?.includes(token) ?? false;
    const value = opaque ? args[i + 1] : args[i + 1]?.trim();
    if (value === undefined || (!opaque && (!value || value.startsWith("-")))) {
      throw new Error(table.missing?.[token] ?? `${token} requires a value`);
    }
    flags.set(token, value);
    i++;
  }
  return { positional, flags };
}

// --model accepts an Anthropic alias ("opus"/"sonnet" — resolved through the
// provider's modelMap on provider-backed projects) or any concrete model id
// the backend accepts; garden does not maintain a model list to validate
// against (docs/MULTI-MODEL.md "Layer 2"). It is interpolated into launch
// commands via shellEscape, so the only hard requirement is non-emptiness.
export function requireModelValue(raw: string): string {
  const model = raw.trim();
  if (!model) throw new Error("--model requires a non-empty value");
  return model;
}

// --effort takes the rungs of the harness the worker builds with, so a Codex
// worker can be given Codex's `max`. On claude-code, "ultra" is the ultracode
// preset (max effort + dynamic workflows), a launch mode no other harness has;
// Codex's own "ultra" is a plain rung. Maps to newWorker's effort/ultracode
// fields — the two are mutually exclusive, so exactly one is returned.
export function parseEffortFlag(
  raw: string, harness: string,
): { effort?: string; ultracode?: boolean } {
  const value = raw.trim();
  const preset = harness === "claude-code";
  if (preset && value === "ultra") return { ultracode: true };
  const rungs = workerEffortRungs(harness);
  if (rungs.includes(value)) return { effort: value };
  const names = preset ? [...rungs, "ultra"] : rungs;
  throw new Error(`--effort must be one of: ${names.join(", ")} for a ${harness} worker, got '${raw}'`);
}
