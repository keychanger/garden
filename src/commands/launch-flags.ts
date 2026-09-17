// Shared `--model` / `--effort` flag parsing for the two commands that spawn a
// worker: `garden workers new` and `garden handoff`. One vocabulary, so the
// sandboxed handoff path cannot drift from the direct one. A leaf by design —
// handoff.ts runs in a worker pane and reads the effort rungs from
// dashboard/worker-effort.ts rather than create.ts's launch closure.
import { WORKER_EFFORT_LEVELS, isWorkerEffort } from "../dashboard/worker-effort.js";

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

// --effort accepts the four reasoning rungs or "ultra" (the ultracode preset:
// max effort + dynamic workflows). Maps to newWorker's effort/ultracode fields
// — the two are mutually exclusive, so exactly one is returned. Default/grow
// only; trellis resolves its own model and carries no effort.
export function parseEffortFlag(raw: string): { effort?: string; ultracode?: boolean } {
  const value = raw.trim();
  if (value === "ultra") return { ultracode: true };
  if (isWorkerEffort(value)) return { effort: value };
  throw new Error(`--effort must be one of: ${[...WORKER_EFFORT_LEVELS, "ultra"].join(", ")}, got '${raw}'`);
}
