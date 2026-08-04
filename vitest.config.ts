import { defineConfig } from "vitest/config";

// Thresholds sit ~5pp below current baseline: fail on regression, not noise.
//
// Integration tests under test/integration/ ARE included by default (`npm
// test`). The coverage script alone excludes them because CI/checks invokes
// `test:integration` immediately afterward; running them under both commands
// doubled the slow real-process suite without adding evidence. The dedicated
// gate remains load-bearing: its bundled-hook test is the only check that
// catches module-init cycles under esbuild's bundling order — source-level
// resolution will not. Excluding integration from `npm test` let that exact
// regression ship in May 2026.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 30000,
    // Pin HOME to a throwaway dir so no test can read the operator's real
    // ~/.garden — that is what let a config-reading regression pass locally
    // and fail on CI. See test/setup-home.ts.
    setupFiles: ["test/setup-home.ts"],
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
        // High-risk lifecycle and execution boundaries, baselined against the
        // unit-only coverage gate in August 2026 with ~5pp headroom.
        "src/dashboard/workers.ts": { lines: 86, statements: 85, functions: 95, branches: 77 },
        "src/dashboard/create.ts": { lines: 44, statements: 41, functions: 72, branches: 27 },
        "src/dashboard/handoff-dispatch.ts": { lines: 89, statements: 85, functions: 95, branches: 82 },
        "src/dashboard/file-lock.ts": { lines: 82, statements: 81, functions: 95, branches: 79 },
        "src/dashboard/launch-plan.ts": { lines: 90, statements: 90, functions: 95, branches: 90 },
        "src/dashboard/harness/claude-code-core.ts": { lines: 89, statements: 87, functions: 70, branches: 82 },
        "src/dashboard/harness/codex-core.ts": { lines: 74, statements: 71, functions: 80, branches: 64 },
        lines: 60,
        statements: 60,
        functions: 60,
        branches: 55,
      },
    },
  },
});
