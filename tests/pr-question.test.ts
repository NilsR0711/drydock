import { describe, expect, it } from "vitest";
import {
  buildQuestionPrompt,
  MAX_DIFF_CHARS,
  MAX_LOG_LINES,
  MAX_QUESTION_CHARS,
  type PrQuestionContext,
  parseAnswer,
  truncate,
} from "@/lib/issues/pr-question";

function context(over: Partial<PrQuestionContext> = {}): PrQuestionContext {
  return {
    prNumber: 42,
    branch: "fix/123",
    jobStatus: "ci_running",
    issueNumber: 123,
    issueTitle: "Add export button",
    issueBody: "We need a CSV export button on the dashboard.",
    checks: [
      { name: "test", state: "pass" },
      { name: "lint", state: "fail" },
    ],
    feedback: ["[pending] alice (actionable): rename the helper"],
    log: ["worktree: prepared", "status: working", "result: done"],
    diff: "diff --git a/x.ts b/x.ts\n+const a = 1;",
    ...over,
  };
}

describe("truncate", () => {
  it("returns the text unchanged when within the limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("caps the text and appends a truncation marker beyond the limit", () => {
    const out = truncate("abcdefghij", 4);
    expect(out.startsWith("abcd")).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("buildQuestionPrompt", () => {
  it("instructs the agent to stay read-only", () => {
    const prompt = buildQuestionPrompt({ question: "why?", context: context() });
    expect(prompt.toLowerCase()).toContain("read-only");
    expect(prompt.toLowerCase()).toContain("do not");
  });

  it("includes the user's question and PR metadata", () => {
    const prompt = buildQuestionPrompt({
      question: "Is the failing test related to this PR?",
      context: context(),
    });
    expect(prompt).toContain("Is the failing test related to this PR?");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("fix/123");
    expect(prompt).toContain("Add export button");
  });

  it("renders the check, feedback, log, and diff context sections", () => {
    const prompt = buildQuestionPrompt({ question: "q", context: context() });
    expect(prompt).toContain("test");
    expect(prompt).toContain("lint");
    expect(prompt).toContain("rename the helper");
    expect(prompt).toContain("status: working");
    expect(prompt).toContain("const a = 1;");
  });

  it("caps the diff to MAX_DIFF_CHARS", () => {
    const huge = `x`.repeat(MAX_DIFF_CHARS + 5000);
    const prompt = buildQuestionPrompt({ question: "q", context: context({ diff: huge }) });
    expect(prompt).toContain("truncated");
  });

  it("caps the question to MAX_QUESTION_CHARS", () => {
    const huge = "q".repeat(MAX_QUESTION_CHARS + 500);
    const prompt = buildQuestionPrompt({ question: huge, context: context() });
    expect(prompt).toContain("truncated");
  });

  it("keeps only the most recent MAX_LOG_LINES log lines", () => {
    const many = Array.from({ length: MAX_LOG_LINES + 20 }, (_, i) => `line ${i}`);
    const prompt = buildQuestionPrompt({ question: "q", context: context({ log: many }) });
    expect(prompt).toContain(`line ${MAX_LOG_LINES + 19}`);
    expect(prompt).not.toContain("line 0\n");
  });

  it("handles an empty context gracefully", () => {
    const prompt = buildQuestionPrompt({
      question: "q",
      context: context({ checks: [], feedback: [], log: [], diff: "", branch: null }),
    });
    expect(prompt).toContain("q");
    expect(typeof prompt).toBe("string");
  });
});

describe("parseAnswer", () => {
  it("trims surrounding whitespace", () => {
    expect(parseAnswer("  the answer  \n")).toBe("the answer");
  });

  it("returns null for an empty or whitespace-only response", () => {
    expect(parseAnswer("")).toBeNull();
    expect(parseAnswer("   \n  ")).toBeNull();
  });
});
