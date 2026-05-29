import { describe, expect, it } from "vitest";
import {
  buildFixPrompt,
  classifyFailureKind,
  extractEvidence,
  type FailureKind,
} from "@/lib/orchestrator/ci-fix-prompt";

function kind(log: string): FailureKind {
  return classifyFailureKind(log);
}

describe("classifyFailureKind", () => {
  it("detects a TypeScript type error", () => {
    expect(
      kind("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'."),
    ).toBe("type");
  });

  it("detects a vitest test failure", () => {
    expect(
      kind(
        ["FAIL tests/foo.test.ts > does a thing", "AssertionError: expected 1 to be 2"].join("\n"),
      ),
    ).toBe("test");
  });

  it("detects a biome lint failure", () => {
    expect(kind("src/a.ts:1:1 lint/suspicious/noExplicitAny  Unexpected any.")).toBe("lint");
  });

  it("detects an eslint lint failure", () => {
    expect(
      kind("  3:10  error  'x' is assigned but never used  @typescript-eslint/no-unused-vars"),
    ).toBe("lint");
  });

  it("detects a build/compile failure", () => {
    expect(
      kind("Failed to compile.\n./src/page.tsx\nModule not found: Can't resolve './missing'"),
    ).toBe("build");
  });

  it("detects a dependency failure", () => {
    expect(kind("npm ERR! code ERESOLVE\nnpm ERR! Could not resolve dependency")).toBe(
      "dependency",
    );
  });

  it("detects a pnpm dependency failure", () => {
    expect(kind("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen lockfile")).toBe(
      "dependency",
    );
  });

  it("detects a timeout", () => {
    expect(kind("Error: Test timed out in 5000ms.")).toBe("timeout");
  });

  it("detects a flaky network failure", () => {
    expect(kind("fetch failed: ECONNRESET")).toBe("flaky");
  });

  it("falls back to unknown when nothing matches", () => {
    expect(kind("something we do not recognise at all")).toBe("unknown");
  });

  describe("precedence", () => {
    it("prefers a TS type error over a generic build banner", () => {
      // Next.js build runs type checking; the TS code is the actionable signal.
      expect(
        kind(["Failed to compile.", "./src/a.ts:3:5", "Type error: TS2322: Type x"].join("\n")),
      ).toBe("type");
    });

    it("prefers a test failure over a timeout mentioned in passing", () => {
      expect(kind(["FAIL tests/a.test.ts > x", "Expected: 1", "Received: 2"].join("\n"))).toBe(
        "test",
      );
    });
  });
});

describe("extractEvidence", () => {
  it("returns a focused slice anchored on the failure, not a raw tail", () => {
    const noise = Array.from({ length: 50 }, (_, i) => `::group::step ${i}`);
    const log = [...noise, "error TS2322: Type 'x' is not assignable", "    at foo.ts:3:5"].join(
      "\n",
    );
    const { kind, evidence } = extractEvidence(log, 10);
    expect(kind).toBe("type");
    expect(evidence).toContain("error TS2322");
    expect(evidence.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("caps the evidence by lines, not just characters", () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const { evidence } = extractEvidence(log, 25);
    expect(evidence.split("\n")).toHaveLength(25);
  });

  it("falls back to the tail when no failure marker is found", () => {
    const log = Array.from({ length: 30 }, (_, i) => `noise ${i}`).join("\n");
    const { kind, evidence } = extractEvidence(log, 5);
    expect(kind).toBe("unknown");
    expect(evidence.split("\n")).toEqual([
      "noise 25",
      "noise 26",
      "noise 27",
      "noise 28",
      "noise 29",
    ]);
  });

  it("handles an empty log without throwing", () => {
    const { kind, evidence } = extractEvidence("", 10);
    expect(kind).toBe("unknown");
    expect(evidence).toBe("");
  });

  it("keeps context lines around the anchor", () => {
    const log = [
      "context before",
      "FAIL tests/foo.test.ts > thing",
      "Expected: 1",
      "Received: 2",
    ].join("\n");
    const { evidence } = extractEvidence(log, 10);
    expect(evidence).toContain("FAIL tests/foo.test.ts");
    expect(evidence).toContain("Received: 2");
  });
});

describe("buildFixPrompt", () => {
  it("includes a category-specific instruction for a type error", () => {
    const prompt = buildFixPrompt({
      checkName: "typecheck",
      log: "src/a.ts(3,5): error TS2322: Type 'x' is not assignable",
      maxLines: 50,
    });
    expect(prompt).toContain("typecheck");
    expect(prompt.toLowerCase()).toContain("type error");
    expect(prompt).toContain("error TS2322");
  });

  it("instructs against deleting or skipping tests for a test failure", () => {
    const prompt = buildFixPrompt({
      checkName: "test",
      log: "FAIL tests/foo.test.ts > x\nAssertionError: expected 1 to be 2",
      maxLines: 50,
    });
    expect(prompt.toLowerCase()).toMatch(/do not (delete|skip)/);
    expect(prompt).toContain("FAIL tests/foo.test.ts");
  });

  it("suggests the autofix for a lint failure", () => {
    const prompt = buildFixPrompt({
      checkName: "lint",
      log: "src/a.ts:1:1 lint/suspicious/noExplicitAny Unexpected any.",
      maxLines: 50,
    });
    expect(prompt.toLowerCase()).toContain("lint");
    expect(prompt).toContain("noExplicitAny");
  });

  it("bounds the embedded evidence by the line cap", () => {
    const log = Array.from({ length: 400 }, (_, i) => `error TS2322 line ${i}`).join("\n");
    const prompt = buildFixPrompt({ checkName: "typecheck", log, maxLines: 30 });
    const evidenceLines = log.split("\n").filter((l) => prompt.includes(l)).length;
    expect(evidenceLines).toBeLessThanOrEqual(30);
  });

  it("names the failing check in the prompt", () => {
    const prompt = buildFixPrompt({
      checkName: "Verify Node 22",
      log: "FAIL tests/x.test.ts > y",
      maxLines: 50,
    });
    expect(prompt).toContain("Verify Node 22");
  });
});
