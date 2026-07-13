import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 30000,
    // Same local worker cap as vitest.config.ts — see the comment there.
    maxWorkers: process.env.CI ? undefined : "50%",
  },
});
