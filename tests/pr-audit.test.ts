import { describe, expect, it } from "vitest";
import {
  AUDIT_RECOMMENDATIONS,
  AUDIT_SEVERITIES,
  auditWasTruncated,
  buildPrAuditPrompt,
  languageName,
  MAX_AUDIT_DIFF_CHARS,
  MAX_AUDIT_FINDINGS,
  MAX_AUDIT_ISSUE_BODY_CHARS,
  type PrAuditInput,
  type PrAuditResult,
  parsePrAudit,
  prAuditMarker,
  renderPrAuditComment,
  renderPrAuditFailureComment,
} from "@/lib/issues/pr-audit";

function baseInput(overrides: Partial<PrAuditInput> = {}): PrAuditInput {
  return {
    issueNumber: 42,
    issueTitle: "Add login rate limiting",
    issueBody: "We need to throttle login attempts.",
    subtasks: [
      { ordinal: 1, title: "Add limiter middleware" },
      { ordinal: 2, title: "Cover with tests" },
    ],
    prNumber: 7,
    branch: "drydock/issue-42",
    diff: "diff --git a/src/login.ts b/src/login.ts\n+const x = 1;\n",
    checks: [
      { name: "Verify (Node 22)", state: "SUCCESS" },
      { name: "CodeQL", state: "FAILURE" },
    ],
    language: "en",
    ...overrides,
  };
}

function baseResult(overrides: Partial<PrAuditResult> = {}): PrAuditResult {
  return {
    summary: "Solid change with one risky spot.",
    recommendation: "comment",
    findings: [
      {
        severity: "major",
        title: "Unbounded retry loop",
        body: "The retry loop has no cap.",
        path: "src/login.ts",
        line: 12,
        suggestion: "Cap retries at 3.",
      },
      {
        severity: "praise",
        title: "Good test coverage",
        body: "Edge cases are covered.",
      },
    ],
    issueCoverage: { met: ["Add limiter middleware"], missing: ["Cover with tests"] },
    ...overrides,
  };
}

describe("pr-audit constants", () => {
  it("exposes the documented severity and recommendation sets", () => {
    expect(AUDIT_SEVERITIES).toEqual(["blocker", "major", "minor", "nit", "praise"]);
    expect(AUDIT_RECOMMENDATIONS).toEqual(["approve", "request_changes", "comment"]);
  });
});

describe("languageName", () => {
  it("maps simple codes to English language names", () => {
    expect(languageName("en")).toBe("English");
    expect(languageName("de")).toBe("German");
  });

  it("falls back to the raw code for unknown values", () => {
    expect(languageName("zz-ZZ9")).toBe("zz-ZZ9");
    expect(languageName("")).toBe("English");
  });
});

describe("buildPrAuditPrompt", () => {
  it("includes issue, subtasks, PR metadata, CI summary, and the diff", () => {
    const prompt = buildPrAuditPrompt(baseInput());
    expect(prompt).toContain("Issue #42: Add login rate limiting");
    expect(prompt).toContain("We need to throttle login attempts.");
    expect(prompt).toContain("[ordinal 1] Add limiter middleware");
    expect(prompt).toContain("Pull request #7");
    expect(prompt).toContain("drydock/issue-42");
    expect(prompt).toContain("Verify (Node 22): SUCCESS");
    expect(prompt).toContain("CodeQL: FAILURE");
    expect(prompt).toContain("diff --git a/src/login.ts");
  });

  it("instructs a read-only review with strict JSON output", () => {
    const prompt = buildPrAuditPrompt(baseInput());
    expect(prompt).toMatch(/READ-ONLY/);
    expect(prompt).toContain('"recommendation"');
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"issueCoverage"');
    expect(prompt).toContain('"blocker"');
  });

  it("covers the six review dimensions", () => {
    const prompt = buildPrAuditPrompt(baseInput());
    for (const dim of [
      "Correctness",
      "Security",
      "Tests",
      "API / compatibility",
      "Maintainability",
      "Issue fit",
    ]) {
      expect(prompt).toContain(dim);
    }
  });

  it("instructs the model to write in the configured language", () => {
    const prompt = buildPrAuditPrompt(baseInput({ language: "de" }));
    expect(prompt).toContain("German");
  });

  it("defaults to English when the language is empty", () => {
    const prompt = buildPrAuditPrompt(baseInput({ language: "" }));
    expect(prompt).toContain("English");
  });

  it("caps an oversized diff and issue body with a truncation marker", () => {
    const prompt = buildPrAuditPrompt(
      baseInput({
        diff: "x".repeat(MAX_AUDIT_DIFF_CHARS + 500),
        issueBody: "y".repeat(MAX_AUDIT_ISSUE_BODY_CHARS + 500),
      }),
    );
    expect(prompt).toContain("…[truncated 500 chars]");
    expect(prompt.length).toBeLessThan(MAX_AUDIT_DIFF_CHARS + MAX_AUDIT_ISSUE_BODY_CHARS + 5_000);
  });

  it("handles an issue without subtasks and without checks", () => {
    const prompt = buildPrAuditPrompt(baseInput({ subtasks: [], checks: [] }));
    expect(prompt).toContain("no tracked subtasks");
    expect(prompt).toContain("No CI results available");
  });
});

describe("auditWasTruncated", () => {
  it("is false for inputs within bounds", () => {
    expect(auditWasTruncated(baseInput())).toBe(false);
  });

  it("is true when the diff exceeds its cap", () => {
    expect(auditWasTruncated(baseInput({ diff: "x".repeat(MAX_AUDIT_DIFF_CHARS + 1) }))).toBe(true);
  });

  it("is true when the issue body exceeds its cap", () => {
    expect(
      auditWasTruncated(baseInput({ issueBody: "y".repeat(MAX_AUDIT_ISSUE_BODY_CHARS + 1) })),
    ).toBe(true);
  });
});

describe("parsePrAudit", () => {
  const valid = JSON.stringify({
    summary: "Looks good overall.",
    recommendation: "approve",
    findings: [
      {
        severity: "minor",
        title: "Naming nit",
        body: "Rename x to attempts.",
        path: "src/login.ts",
        line: 3,
        suggestion: "const attempts = 1;",
      },
    ],
    issueCoverage: { met: ["a"], missing: [] },
  });

  it("parses a strict JSON response", () => {
    const result = parsePrAudit(valid);
    expect(result).not.toBeNull();
    expect(result?.recommendation).toBe("approve");
    expect(result?.findings[0]?.severity).toBe("minor");
    expect(result?.findings[0]?.line).toBe(3);
  });

  it("parses JSON wrapped in a markdown fence with prose around it", () => {
    const result = parsePrAudit(`Here is my review:\n\n\`\`\`json\n${valid}\n\`\`\`\nDone.`);
    expect(result?.summary).toBe("Looks good overall.");
  });

  it("returns null when no JSON object is present", () => {
    expect(parsePrAudit("I could not review this PR.")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parsePrAudit('{"summary": "x", ')).toBeNull();
  });

  it("returns null on an unknown severity", () => {
    const bad = valid.replace('"minor"', '"catastrophic"');
    expect(parsePrAudit(bad)).toBeNull();
  });

  it("returns null on an unknown recommendation", () => {
    const bad = valid.replace('"approve"', '"merge_now"');
    expect(parsePrAudit(bad)).toBeNull();
  });

  it("defaults missing optional fields", () => {
    const result = parsePrAudit(
      JSON.stringify({
        summary: "ok",
        recommendation: "comment",
        findings: [{ severity: "nit", title: "t", body: "" }],
      }),
    );
    expect(result?.issueCoverage).toEqual({ met: [], missing: [] });
    expect(result?.findings[0]?.path).toBeUndefined();
    expect(result?.findings[0]?.line).toBeUndefined();
  });

  it("tolerates an empty findings list", () => {
    const result = parsePrAudit(
      JSON.stringify({ summary: "clean", recommendation: "approve", findings: [] }),
    );
    expect(result?.findings).toEqual([]);
  });
});

describe("prAuditMarker", () => {
  it("produces the hidden job-scoped marker", () => {
    expect(prAuditMarker(123)).toBe("<!-- drydock:pr-audit:123 -->");
  });
});

describe("renderPrAuditComment", () => {
  const meta = {
    jobId: 9,
    agent: "claude",
    model: "claude-opus-4-8",
    language: "en",
    truncated: false,
  };

  it("starts with the marker and renders the header with agent, model, and language", () => {
    const md = renderPrAuditComment(baseResult(), meta);
    expect(md.startsWith(prAuditMarker(9))).toBe(true);
    expect(md).toContain("🔍 Drydock PR audit (claude/claude-opus-4-8, en)");
  });

  it("renders the recommendation, summary, findings with anchors, and coverage", () => {
    const md = renderPrAuditComment(baseResult(), meta);
    expect(md).toContain("Solid change with one risky spot.");
    expect(md).toMatch(/Recommendation.*comment/i);
    expect(md).toContain("Unbounded retry loop");
    expect(md).toContain("`src/login.ts:12`");
    expect(md).toContain("Cap retries at 3.");
    expect(md).toContain("Good test coverage");
    expect(md).toContain("Add limiter middleware");
    expect(md).toContain("Cover with tests");
  });

  it("orders findings by severity rank, blockers first", () => {
    const md = renderPrAuditComment(
      baseResult({
        findings: [
          { severity: "praise", title: "PraiseFinding", body: "" },
          { severity: "blocker", title: "BlockerFinding", body: "" },
          { severity: "minor", title: "MinorFinding", body: "" },
        ],
      }),
      meta,
    );
    const blocker = md.indexOf("BlockerFinding");
    const minor = md.indexOf("MinorFinding");
    const praise = md.indexOf("PraiseFinding");
    expect(blocker).toBeGreaterThan(-1);
    expect(blocker).toBeLessThan(minor);
    expect(minor).toBeLessThan(praise);
  });

  it("caps the findings list and notes how many were omitted", () => {
    const findings = Array.from({ length: MAX_AUDIT_FINDINGS + 5 }, (_, i) => ({
      severity: "minor" as const,
      title: `Finding ${i}`,
      body: "",
    }));
    const md = renderPrAuditComment(baseResult({ findings }), meta);
    expect(md).toContain(`Finding ${MAX_AUDIT_FINDINGS - 1}`);
    expect(md).not.toContain(`Finding ${MAX_AUDIT_FINDINGS}\n`);
    expect(md).toContain("5 more finding");
  });

  it("notes truncated context when the input was cut", () => {
    const md = renderPrAuditComment(baseResult(), { ...meta, truncated: true });
    expect(md).toMatch(/truncated/i);
  });

  it("renders a clean-result body when there are no findings", () => {
    const md = renderPrAuditComment(
      baseResult({ findings: [], issueCoverage: { met: [], missing: [] } }),
      meta,
    );
    expect(md).toContain("No findings");
  });

  it("marks the audit as advisory", () => {
    const md = renderPrAuditComment(baseResult(), meta);
    expect(md).toMatch(/advisory/i);
  });
});

describe("renderPrAuditFailureComment", () => {
  it("keeps the marker so a later success updates the same comment", () => {
    const md = renderPrAuditFailureComment(
      { jobId: 9, agent: "codex", model: "gpt-5-codex", language: "en" },
      "The agent returned unparseable output.",
    );
    expect(md.startsWith(prAuditMarker(9))).toBe(true);
    expect(md).toContain("🔍 Drydock PR audit");
    expect(md).toContain("The agent returned unparseable output.");
    expect(md).toMatch(/failed/i);
  });
});
