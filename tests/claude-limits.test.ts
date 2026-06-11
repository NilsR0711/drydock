import { describe, expect, it } from "vitest";
import { classifyClaudeFailure } from "@/lib/agents/claude-limits";

// Recorded failure shapes from real Claude Code CLI runs (issue #166). The
// exact strings vary by CLI version, so detection is table-driven: each row is
// a fixture of stderr/result output paired with the expected classification.
const failed = { exitCode: 1, stderr: "" };

describe("classifyClaudeFailure", () => {
  describe("usage limits", () => {
    it("classifies the pipe-epoch usage limit result and parses the reset time", () => {
      const info = classifyClaudeFailure({
        ...failed,
        resultText: "Claude AI usage limit reached|1749924000",
        resultIsError: true,
      });
      expect(info).toMatchObject({ agent: "claude", kind: "usage_limit", resetAt: 1749924000 });
    });

    it("classifies the prose usage limit message without a parseable reset", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
      });
      expect(info).toMatchObject({ kind: "usage_limit" });
      expect(info?.resetAt).toBeUndefined();
    });

    it("classifies the 5-hour window message", () => {
      const info = classifyClaudeFailure({
        ...failed,
        resultText: "5-hour limit reached ∙ resets 6pm",
        resultIsError: true,
      });
      expect(info?.kind).toBe("usage_limit");
    });

    it("classifies the weekly limit message", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "Weekly limit reached, resets Thursday 9am",
      });
      expect(info?.kind).toBe("usage_limit");
    });

    it("ignores an implausibly short epoch after the pipe", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "Claude AI usage limit reached|99",
      });
      expect(info?.kind).toBe("usage_limit");
      expect(info?.resetAt).toBeUndefined();
    });

    it("prefers usage_limit over rate_limit when both phrases appear", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "Claude AI usage limit reached|1749924000 (rate limit exceeded)",
      });
      expect(info?.kind).toBe("usage_limit");
    });
  });

  describe("API rate limits and overload", () => {
    it("classifies a 429 rate_limit_error", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr:
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      });
      expect(info?.kind).toBe("rate_limit");
    });

    it("parses a retry-after hint in seconds", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "rate_limit_error: too many requests, retry after 30 seconds",
      });
      expect(info?.kind).toBe("rate_limit");
      expect(info?.retryAfterMs).toBe(30_000);
    });

    it("classifies a 529 overloaded_error", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr:
          'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      });
      expect(info?.kind).toBe("overloaded");
    });
  });

  describe("auth and billing", () => {
    it("classifies an invalid API key as auth", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "Invalid API key · Please run /login",
      });
      expect(info?.kind).toBe("auth");
    });

    it("classifies a 401 authentication_error as auth", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr:
          'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      });
      expect(info?.kind).toBe("auth");
    });

    it("classifies an expired OAuth token as auth", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "OAuth token has expired. Please obtain a new token or refresh your existing one.",
      });
      expect(info?.kind).toBe("auth");
    });

    it("classifies a low credit balance as billing", () => {
      const info = classifyClaudeFailure({
        ...failed,
        resultText: "Your credit balance is too low to access the Anthropic API.",
        resultIsError: true,
      });
      expect(info?.kind).toBe("billing");
    });

    it("prefers auth over usage_limit when both phrases appear", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "Invalid API key · Please run /login (usage limit reached)",
      });
      expect(info?.kind).toBe("auth");
    });
  });

  describe("non-limit failures", () => {
    it("returns undefined for a generic non-zero failure", () => {
      expect(
        classifyClaudeFailure({ ...failed, stderr: "TypeError: cannot read properties" }),
      ).toBeUndefined();
    });

    it("ignores incidental mentions of rate limits in unrelated failure output", () => {
      // A failed session whose output merely *discusses* rate limiting (e.g. a
      // tool response echoed into the result) is not a provider condition.
      expect(
        classifyClaudeFailure({
          ...failed,
          resultText: "The downstream API applies a rate limit per client; added caching.",
          resultIsError: true,
        }),
      ).toBeUndefined();
    });

    it("ignores incidental mentions of overload in unrelated failure output", () => {
      expect(
        classifyClaudeFailure({
          ...failed,
          stderr: "worker pool overloaded, dropping task",
        }),
      ).toBeUndefined();
    });

    it("still matches the real exceeded-rate-limit phrasing", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: "Number of request tokens has exceeded your per-minute rate limit",
      });
      expect(info?.kind).toBe("rate_limit");
    });

    it("returns undefined for empty output", () => {
      expect(classifyClaudeFailure({ exitCode: 1, stderr: "   " })).toBeUndefined();
    });

    it("never classifies a successful session, even when its text mentions limits", () => {
      // A passing agent run may legitimately *talk* about usage limits (e.g.
      // this very feature); only failed sessions are classified.
      expect(
        classifyClaudeFailure({
          exitCode: 0,
          stderr: "",
          resultText: "Implemented usage limit reached handling",
          resultIsError: false,
        }),
      ).toBeUndefined();
    });

    it("classifies an is_error result even when the exit code is zero", () => {
      const info = classifyClaudeFailure({
        exitCode: 0,
        stderr: "",
        resultText: "Claude AI usage limit reached|1749924000",
        resultIsError: true,
      });
      expect(info?.kind).toBe("usage_limit");
    });
  });

  describe("rawSnippet", () => {
    it("captures the matching line, capped in length", () => {
      const long = `Claude AI usage limit reached|1749924000 ${"x".repeat(500)}`;
      const info = classifyClaudeFailure({ ...failed, stderr: `noise before\n${long}` });
      expect(info?.rawSnippet.startsWith("Claude AI usage limit reached")).toBe(true);
      expect(info?.rawSnippet.length).toBeLessThanOrEqual(300);
    });

    it("redacts secrets echoed alongside the failure", () => {
      const info = classifyClaudeFailure({
        ...failed,
        stderr: `Invalid API key · Please run /login (key: sk-ant-${"a".repeat(24)})`,
      });
      expect(info?.kind).toBe("auth");
      expect(info?.rawSnippet).not.toContain("sk-ant-");
      expect(info?.rawSnippet).toContain("[REDACTED]");
    });
  });
});
