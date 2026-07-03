import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    globals: true,
    css: false,
    // Coverage is opt-in via `pnpm test:coverage` (issue #389); the default
    // `pnpm test` run stays uninstrumented and fast. Scoped to the library
    // code so the report focuses on the logic that matters, not framework
    // glue or UI.
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      reporter: ["text", "lcov"],
      // Follow-up (issue #389): once a baseline is captured in CI, turn the
      // coverage step blocking and enforce modest per-directory thresholds
      // for the critical paths, e.g.:
      //   thresholds: {
      //     "src/lib/orchestrator/**": { lines: 80 },
      //     "src/lib/github/**": { lines: 80 },
      //   },
    },
  },
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
