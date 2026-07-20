// The Codex model catalog, for the spawn composer's model dim.
//
// Codex refreshes its own model list into $CODEX_HOME/models_cache.json, and
// that file is the source of truth: it carries the current slugs, their
// operator-facing display names, a `visibility` flag (deprecated/internal
// models are marked "hide"), and a `priority` ordering. Reading it means the
// composer offers whatever the installed Codex actually supports and needs no
// edit when OpenAI ships a new model — the opposite of the Anthropic side,
// whose alias set (opus/sonnet/haiku/fable) is stable enough to be a literal.
//
// The cache is Codex's file, not garden's: it may be absent (Codex installed
// but never run, or a fleet with no Codex at all) and its shape may drift. Every
// read is therefore best-effort behind CODEX_FALLBACK_MODELS — a stale-but-valid
// list beats an empty submenu, and the CLI (`workers new --model <id>`) covers
// any slug the catalog does not list, exactly as it does for exotic Anthropic
// model ids.
//
// CLI-only (the composer). Deliberately not reachable from the hook bundle.
import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./codex-core.js";

// Used when the cache is missing or unreadable. Verified present in the
// catalog of codex-cli 0.144.5 (2026-07-20).
export const CODEX_FALLBACK_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];

// Codex's reasoning rungs (`model_reasoning_effort`). A superset of garden's
// claude-code ladder — it shares low/medium/high/xhigh and adds "max" and
// "ultra" — so the two vocabularies are NOT interchangeable and each harness's
// composer submenu offers its own. Note "ultra" here is a genuine Codex
// reasoning level, unrelated to garden's "ultra" sentinel for the claude-code
// ultracode preset; buildAgentCommand passes it through as a config value.
// A given model supports a subset (per-model `supported_reasoning_levels`);
// the union is offered because Codex accepts and clamps an unsupported rung.
export const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];

interface CachedModel {
  slug?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

function catalogPath(): string {
  return path.join(codexHome(), "models_cache.json");
}

// Selectable Codex model slugs, most-capable first (Codex's own `priority`
// ordering). Hidden models are dropped — they are the deprecated and internal
// entries Codex itself does not offer.
export function codexModels(): string[] {
  let models: CachedModel[];
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath(), "utf-8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return CODEX_FALLBACK_MODELS;
    models = parsed.models as CachedModel[];
  } catch {
    return CODEX_FALLBACK_MODELS;
  }
  const slugs = models
    .filter((m) => typeof m.slug === "string" && m.slug && m.visibility !== "hide")
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : Infinity)
      - (typeof b.priority === "number" ? b.priority : Infinity))
    .map((m) => m.slug as string);
  return slugs.length > 0 ? slugs : CODEX_FALLBACK_MODELS;
}
