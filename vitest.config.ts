import { defineConfig } from "vitest/config";

// Per-file thresholds were captured from the unit-suite baseline at one bucket
// (5 percentage points) below current — high enough to fail on regression,
// low enough to not flap on noise. Critical lifecycle files (poller, header,
// registry, state, config) sit at ≥85% and are pinned there.
//
// File-level thresholds use minimatch globs against the absolute path. Files
// not matched fall through to the global thresholds at the bottom.

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/version.ts"],
      reporter: ["text", "html"],
      thresholds: {
        // Critical lifecycle files
        "src/dashboard/poller.ts": { lines: 85, statements: 85, functions: 85, branches: 70 },
        "src/dashboard/header.ts": { lines: 85, statements: 80, functions: 85, branches: 75 },
        "src/dashboard/registry.ts": { lines: 95, statements: 95, functions: 95, branches: 85 },
        "src/dashboard/state.ts": { lines: 90, statements: 90, functions: 95, branches: 85 },
        "src/config.ts": { lines: 85, statements: 85, functions: 90, branches: 75 },
        // Global fallback. Numbers are honest — they reflect the current
        // state including untested commands (cli.ts, login.ts, auth.ts,
        // bounce/pause/resume, reset.ts) which haven't gotten unit tests yet.
        // Phase 5 follow-on commits add tests for these and the threshold
        // should be ratcheted up. Set at ~5pp below current baseline so it
        // can only fail on regression, not noise.
        lines: 60,
        statements: 60,
        functions: 60,
        branches: 55,
      },
    },
  },
});
