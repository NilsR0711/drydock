import { describe, expect, it } from "vitest";
import config from "../vitest.config";

// Guards the coverage setup added for issue #389 so it cannot silently
// disappear: without instrumentation, coverage gaps in critical paths
// (orchestrator drivers, GitHub integration) become invisible again.
describe("vitest coverage config", () => {
  const coverage = config.test?.coverage as Record<string, unknown> | undefined;

  it("enables the v8 coverage provider", () => {
    expect(coverage).toBeDefined();
    expect(coverage?.provider).toBe("v8");
  });

  it("scopes coverage collection to src/lib/**", () => {
    expect(coverage?.include).toContain("src/lib/**");
  });

  it("emits both a human-readable text summary and an lcov report", () => {
    expect(coverage?.reporter).toEqual(expect.arrayContaining(["text", "lcov"]));
  });
});
