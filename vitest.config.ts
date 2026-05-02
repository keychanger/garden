import { defineConfig } from "vitest/config";

// Thresholds sit ~5pp below current baseline: fail on regression, not noise.
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
        "src/dashboard/poller.ts": { lines: 85, statements: 85, functions: 85, branches: 70 },
        "src/dashboard/header.ts": { lines: 85, statements: 80, functions: 85, branches: 75 },
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
