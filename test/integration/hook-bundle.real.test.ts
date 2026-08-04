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

// The workflow/poller split reduced the measured minified bundle from 249.0KB
// to 120.8KB. Keep enough headroom for small hook-path changes without letting
// a state-handler graph quietly return.
const HOOK_BUNDLE_CEILING_BYTES = 128 * 1024;
// skills.ts contributes only a tree-shaken sliver today (<100 bytes); a
// retained skills bundle is ~28kb. The threshold sits well between.
const SKILLS_BYTES_CEILING = 2 * 1024;
const POLLER_MODULE_RE = /dashboard\/poller(?:-[^/]+)?\.ts$/;
const ALLOWED_POLLER_LEAF = "src/dashboard/poller-fifo.ts";

describe("hook bundle size guard (real esbuild)", () => {
  it("keeps dist/hook.js lean and poller handlers out", () => {
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

      const retainedPollerModules = Object.keys(inputs)
        .filter(k => POLLER_MODULE_RE.test(k) && k !== ALLOWED_POLLER_LEAF);
      expect(retainedPollerModules).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
