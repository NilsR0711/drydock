import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  classifyFailures,
  type FailureCategory,
} from "@/lib/orchestrator/ci-failure-classifier";

function cat(name: string, output = ""): FailureCategory {
  return classifyFailure("github", { name, state: "FAILURE" }, output).category;
}

describe("classifyFailure", () => {
  describe("healable_in_branch", () => {
    it("classifies typecheck failures", () => {
      expect(cat("typecheck", "src/a.ts(3,5): error TS2322: Type 'x'")).toBe("healable_in_branch");
    });
    it("classifies lint failures", () => {
      expect(cat("lint", "biome found 2 errors")).toBe("healable_in_branch");
    });
    it("classifies unit test failures", () => {
      expect(cat("test", "FAIL tests/foo.test.ts > does a thing")).toBe("healable_in_branch");
    });
    it("classifies build failures", () => {
      expect(cat("build", "Build failed: compile error")).toBe("healable_in_branch");
    });
    it("classifies stale generated artifacts", () => {
      expect(cat("verify-generated", "generated files are out of date, run codegen")).toBe(
        "healable_in_branch",
      );
    });
  });

  describe("blocked_external", () => {
    it("never heals a cancelled run", () => {
      expect(classifyFailure("github", { name: "build", state: "CANCELLED" }).category).toBe(
        "blocked_external",
      );
    });
    it("classifies missing secrets", () => {
      expect(cat("deploy", "Error: required secret NPM_TOKEN is not set")).toBe("blocked_external");
    });
    it("classifies external 5xx", () => {
      expect(cat("publish", "registry responded with 503 Service Unavailable")).toBe(
        "blocked_external",
      );
    });
    it("classifies rate limiting", () => {
      expect(cat("fetch-deps", "You have exceeded a secondary rate limit")).toBe(
        "blocked_external",
      );
    });
    it("classifies AI-review style checks by name", () => {
      expect(cat("AI Review", "")).toBe("blocked_external");
      expect(cat("claude-code-review", "")).toBe("blocked_external");
    });
  });

  describe("flaky_or_ambiguous", () => {
    it("classifies timed-out runs", () => {
      expect(classifyFailure("github", { name: "e2e", state: "TIMED_OUT" }).category).toBe(
        "flaky_or_ambiguous",
      );
    });
    it("classifies timeout text", () => {
      expect(cat("integration", "Test timed out after 30000ms")).toBe("flaky_or_ambiguous");
    });
    it("classifies intermittent text", () => {
      expect(cat("e2e", "known intermittent network blip, ECONNRESET")).toBe("flaky_or_ambiguous");
    });
  });

  describe("unknown", () => {
    it("falls back to unknown when nothing matches", () => {
      expect(cat("mystery-gate", "something happened we don't recognise")).toBe("unknown");
    });
  });

  describe("precedence", () => {
    it("prefers blocked_external over healable for a cancelled typecheck", () => {
      expect(classifyFailure("github", { name: "typecheck", state: "CANCELLED" }).category).toBe(
        "blocked_external",
      );
    });
    it("prefers flaky over healable for a timed-out test run", () => {
      expect(cat("test", "Test timed out after 30000ms")).toBe("flaky_or_ambiguous");
    });
  });

  describe("fingerprint", () => {
    it("is provider:category:checkName", () => {
      const f = classifyFailure("github", { name: "typecheck", state: "FAILURE" }, "error TS2322");
      expect(f.fingerprint).toBe("github:healable_in_branch:typecheck");
    });
    it("normalises check name casing and whitespace for stable dedupe", () => {
      const a = classifyFailure("gitlab", { name: "Type Check", state: "FAILURE" }, "tsc error");
      const b = classifyFailure("gitlab", { name: "type check", state: "FAILURE" }, "tsc error");
      expect(a.fingerprint).toBe(b.fingerprint);
    });
  });
});

describe("classifyFailures", () => {
  it("classifies a batch of failing checks", () => {
    const out = classifyFailures("github", [
      { check: { name: "typecheck", state: "FAILURE" }, output: "error TS1" },
      { check: { name: "AI Review", state: "FAILURE" } },
    ]);
    expect(out.map((f) => f.category)).toEqual(["healable_in_branch", "blocked_external"]);
  });
});
