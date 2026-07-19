// Guard for the hook bundle's size invariant (real esbuild, no mocks).
//
// dist/hook.js runs on every tool call of every agent — its node cold-start
// was the dominant dashboard-lag cause, and the dedicated minimal entrypoint
// plus tree-shaking keep it cheap. Two things protect that today: the
// harness core/full split (harness/core.ts vs harness/index.ts) and
// package.json's "sideEffects": false, which lets esbuild shake the heavy
// adapter methods that are import-reachable from the hook graph via
// loop.ts/create.ts. If either regresses — a new static edge that retains
// installRuntimeConfig's closure, a module that grows import-time side
// effects, the flag being dropped — the skills/sandbox content lands in the
// bundle and this test fails before the lag ships.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Ceiling above today's ~225kb minified production bundle (minify +
// keep-names): trips on the ~28kb step a retained adapter/skills closure adds,
// not on routine drift. The precise detector for that regression is
// SKILLS_BYTES_CEILING below (it reads skills.ts's bytesInOutput straight from
// the metafile); this total-size ceiling is the coarse backstop for any other
// large retained closure. renderQuickStatus and its row-render helpers are
// import-reachable from the hook graph via header.ts, so incremental status-pane
// work lands here — a future extraction of the render path out of the commands
// layer would shrink this back down. Bumped 216->220kb for the OPERATOR-UI
// status-pane grammar (Phase 3: identity badges, ANSI-aware width helpers,
// workflow row decoration, per-project alert counts). Bumped 220->224kb for the
// holistic whole-task final review: its aggregated-diff prompt sections
// (prompts.ts) and verdict handler (poller-review.ts) are import-reachable from
// the hook graph via the existing review path — legitimate feature code, not a
// retained closure (skills stayed fully shaken out, SKILLS_BYTES_CEILING=0).
// Bumped 224->228kb for the Haiku verdict-extraction fallback (verdict-extract.ts,
// ~1.9kb): poller-review.ts is import-reachable from the hook graph, so its new
// dependency rides in — again legitimate review-recovery code, not a retained
// closure. The ~28kb regression this guard exists for is still caught by
// SKILLS_BYTES_CEILING and by the remaining ~3kb of coarse headroom.
// Bumped 228->230kb for the botanist skip-review handler (poller-review.ts
// handleSkipReviewMerge, ~0.5kb): same shape — legitimate state-handler feature
// code reachable via the workflow-def stateHandlers the hook graph already
// carries. The heavy publish logic (git commit/move) is deliberately kept out
// via the botanist-paths.ts leaf (only isPublishablePath rides in), verified by
// the metafile below and by publishBotanistArtifact being absent from the bundle.
// Bumped 230->236kb for two client-readiness security changes: the js-yaml
// 4.1.1->4.3.0 advisory upgrade (js-yaml rides in via config.ts's loadConfig,
// which the hook graph carries) is the bulk, plus the reviewer-race
// clean-worktree gate in poller-review.ts handleWorking (~0.3kb). Both are
// legitimate reachable code, not a retained closure; SKILLS_BYTES_CEILING still
// guards the skills-content regression this backstop was built for.
const HOOK_BUNDLE_CEILING_BYTES = 236 * 1024;
// skills.ts contributes only a tree-shaken sliver today (<100 bytes); a
// retained skills bundle is ~28kb. The threshold sits well between.
const SKILLS_BYTES_CEILING = 2 * 1024;

describe("hook bundle size guard (real esbuild)", () => {
  it("keeps dist/hook.js lean and the skills content shaken out", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garden-hook-bundle-"));
    const outfile = path.join(tmp, "hook.js");
    const metafile = path.join(tmp, "meta.json");
    try {
      execFileSync("npx", [
        "esbuild", "src/hook-entry.ts",
        "--bundle", "--platform=node", "--format=esm",
        "--minify", "--keep-names",
        `--outfile=${outfile}`,
        `--metafile=${metafile}`,
        '--define:__GARDEN_VERSION__="test"',
      ], { cwd: path.resolve(__dirname, "../.."), stdio: "pipe", timeout: 60_000 });

      const size = fs.statSync(outfile).size;
      expect(size).toBeLessThan(HOOK_BUNDLE_CEILING_BYTES);

      const meta = JSON.parse(fs.readFileSync(metafile, "utf-8"));
      const outKey = Object.keys(meta.outputs).find((k) => k.endsWith("hook.js"))!;
      const inputs = meta.outputs[outKey].inputs as Record<string, { bytesInOutput: number }>;
      const skillsBytes = Object.entries(inputs)
        .filter(([k]) => k.endsWith("dashboard/skills.ts"))
        .reduce((sum, [, v]) => sum + v.bytesInOutput, 0);
      expect(skillsBytes).toBeLessThan(SKILLS_BYTES_CEILING);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
