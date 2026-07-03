import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { ciRetries } from "./vitest.retry";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    globals: true,
    css: false,
    // A few timing/parallelism-sensitive suites can flake on loaded CI runners,
    // and those same suites gate `npm publish` via `prepublishOnly` — a single
    // false negative blocks a merge or aborts a release (issue #393). Retry only
    // under CI; locally, surface flakiness immediately. See vitest.retry.ts.
    retry: ciRetries(process.env),
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
