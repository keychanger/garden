import { defineConfig } from "vitest/config";

// Thresholds sit ~5pp below current baseline: fail on regression, not noise.
//
// Integration tests under test/integration/ ARE included by default. The
// bundled hook test (test/integration/claude-hook-bundled.real.test.ts) is
// the only check that catches module-init cycles under esbuild's bundling
// order — vitest's source-level resolution will not. Excluding it from the
// default suite let a regression ship in May 2026 (pickHookMethod throwing
// "Cannot read properties of undefined (reading 'onStop')" on every Claude
// Code hook). The dedicated `test:integration` script (and its config) is
// kept for ad-hoc selective runs but is no longer the merge gate.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 30000,
    // Half the cores locally: several garden workers run this suite
    // concurrently on the operator's workstation, and full-core pools
    // stampede the machine when checks runs overlap. CI runners are
    // isolated VMs — leave them uncapped.
    maxWorkers: process.env.CI ? undefined : "50%",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/version.ts"],
      reporter: ["text", "html"],
      thresholds: {
        // Rebaselined after poller decomposition (f57ce6e) and the workflow-
        // registry refactors (59e865a, b863ee3) shrank these files. The
        // remaining surface is small enough that uncovered error/edge
        // branches now skew percentages disproportionately. Per the
        // ~5pp-below-baseline convention above.
        "src/dashboard/poller.ts": { lines: 78, statements: 74, functions: 70, branches: 57 },
        "src/dashboard/header.ts": { lines: 73, statements: 71, functions: 79, branches: 57 },
        "src/dashboard/registry.ts": { lines: 95, statements: 95, functions: 95, branches: 85 },
        "src/dashboard/state.ts": { lines: 90, statements: 90, functions: 95, branches: 85 },
        "src/config.ts": { lines: 85, statements: 85, functions: 90, branches: 75 },
        lines: 60,
        statements: 60,
        functions: 60,
        branches: 55,
      },
    },
  },
});
