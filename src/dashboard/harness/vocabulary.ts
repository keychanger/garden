// The model and effort names a build member takes, for the menus that offer
// them (the ⌥⇧N spawn composer, the ⌥, project menu), the project effort
// setter that accepts them, and the per-spawn `--effort` of `workers new` and
// `garden handoff`.
//
// Model / effort vocabularies belong to the build MEMBER, not to garden: Codex
// names concrete slugs (gpt-5.6-sol) where Anthropic names aliases (opus), a
// provider serves only the aliases its modelMap defines, and Codex's reasoning
// rungs are its own `model_reasoning_effort` values. Offering one member's
// vocabulary while another builds is the bug these lists exist to prevent.
//
// Kept apart from workflow-picker.ts so the project menu and the config writer
// read them without pulling in the spawn composer's graph. CLI-only, like the
// Codex catalog it reads.
import type { GardenConfig } from "../../config.js";
import { WORKER_EFFORT_LEVELS } from "../worker-effort.js";
import { codexModels, CODEX_EFFORT_LEVELS } from "./codex-models.js";

const CODEX_HARNESS = "codex";

// Suggested models for a claude-code build member — the everyday Anthropic
// aliases (fable included, per the "fable ultracode" ergonomic). Opaque
// strings passed to `--model`; the CLI `workers new --model <id>` covers any
// exotic id, exactly as base/crew keep their fixed lists.
const COMPOSER_MODELS = ["opus", "sonnet", "haiku", "fable"];

// The claude-code effort rungs: the four `--effort` levels plus "ultra" — the
// top rung the consumer maps to the ultracode preset.
const COMPOSER_EFFORTS = [...WORKER_EFFORT_LEVELS, "ultra"];

// The model aliases a provider actually serves — the keys of its `modelMap`,
// which is the whole set of names that resolve to a real backend model for it.
// Offering the full Anthropic list would be wrong in both directions: an
// unmapped alias reaches the provider as a literal it does not know, and the
// provider may map only a subset (`haiku` alone). An empty/absent map means the
// provider serves whatever its endpoint defaults to, so the caller falls back.
export function providerModelAliases(provider: string, config: GardenConfig): string[] {
  const map = config.providers?.[provider]?.modelMap ?? {};
  return Object.entries(map).filter(([, v]) => v).map(([k]) => k);
}

export function composerModels(harness: string, providerAliases?: string[]): string[] {
  if (harness === CODEX_HARNESS) return codexModels();
  // A provider is reached through claude-code, so it shares the harness but
  // NOT the model vocabulary.
  if (providerAliases && providerAliases.length > 0) return providerAliases;
  return COMPOSER_MODELS;
}

export function composerEfforts(harness: string): string[] {
  return harness === CODEX_HARNESS ? CODEX_EFFORT_LEVELS : COMPOSER_EFFORTS;
}

// The rungs a worker on `harness` launches with: the values WorkerEntry.effort
// carries and the adapter renders. claude-code's composer "ultra" is not one of
// them, since it names the ultracode preset, which travels as `ultracode`;
// Codex's own "ultra" is.
export function workerEffortRungs(harness: string): readonly string[] {
  return harness === CODEX_HARNESS ? CODEX_EFFORT_LEVELS : WORKER_EFFORT_LEVELS;
}
