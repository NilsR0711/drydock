import { describe, expect, it } from "vitest";
import { classifyCodexFailure } from "@/lib/agents/codex-limits";

// Recorded failure shapes from the Codex CLI (issue #167). The exec JSONL
// carries no structured error codes — `turn.failed` is `{error:{message}}`
// only (openai/codex #22570) — so detection is table-driven over the verbatim
// message strings asserted in codex-rs protocol/src/error_tests.rs.
const failed = { exitCode: 1, stderr: "" };

describe("classifyCodexFailure", () => {
  describe("ChatGPT plan usage limits", () => {
    it("classifies the Plus-plan usage limit message", () => {
      const info = classifyCodexFailure({
        ...failed,
        resultText:
          "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:01 PM.",
        resultIsError: true,
      });
      expect(info).toMatchObject({ agent: "codex", kind: "usage_limit" });
    });

    it("classifies the bare usage limit message with a date reset", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "ERROR: You've hit your usage limit. Try again at Feb 23rd, 2026 9:01 PM.",
      });
      expect(info?.kind).toBe("usage_limit");
      // The CLI reports resets as absolute local-time prose, not machine time;
      // no resetAt is parsed — the latch falls back to its cooldown backoff.
      expect(info?.resetAt).toBeUndefined();
    });

    it("classifies the per-model usage limit message", () => {
      const info = classifyCodexFailure({
        ...failed,
        resultText:
          "You've hit your usage limit for gpt-5-codex. Switch to another model now, or try again at 9:01 PM.",
        resultIsError: true,
      });
      expect(info?.kind).toBe("usage_limit");
    });

    it("classifies a passed-through usage_limit_reached body code", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: 'unexpected status 429: {"error":{"type":"usage_limit_reached"}}',
      });
      expect(info?.kind).toBe("usage_limit");
    });

    it("does not misroute a usage-limit message to billing over its credits-purchase suffix", () => {
      // The Pro-plan variant mentions purchasing credits; that is still a
      // resettable usage window, not an exhausted balance.
      const info = classifyCodexFailure({
        ...failed,
        stderr:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:01 PM.",
      });
      expect(info?.kind).toBe("usage_limit");
    });
  });

  describe("API rate limits", () => {
    it("classifies the exhausted-retries 429 message", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "exceeded retry limit, last status: 429 Too Many Requests, request id: req_abc",
      });
      expect(info?.kind).toBe("rate_limit");
    });

    it("classifies the in-stream TPM message and parses the retry-after hint", () => {
      const info = classifyCodexFailure({
        ...failed,
        resultText:
          "stream disconnected before completion: Rate limit reached for gpt-5-codex in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 11.054s. Visit https://platform.openai.com/account/rate-limits to learn more.",
        resultIsError: true,
      });
      expect(info?.kind).toBe("rate_limit");
      expect(info?.retryAfterMs).toBe(11054);
    });

    it("classifies a passed-through rate_limit_exceeded code", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: 'response.failed: {"code":"rate_limit_exceeded"}',
      });
      expect(info?.kind).toBe("rate_limit");
    });
  });

  describe("quota and billing", () => {
    it("classifies the normalized insufficient-quota message as billing", () => {
      const info = classifyCodexFailure({
        ...failed,
        resultText: "Quota exceeded. Check your plan and billing details.",
        resultIsError: true,
      });
      expect(info?.kind).toBe("billing");
    });

    it("classifies a passed-through insufficient_quota code as billing", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr:
          'unexpected status 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',
      });
      expect(info?.kind).toBe("billing");
    });

    it("classifies exhausted workspace credits as billing", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "Your workspace is out of credits. Add credits to continue.",
      });
      expect(info?.kind).toBe("billing");
    });

    it("classifies a workspace spend cap as billing", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr:
          "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
      });
      expect(info?.kind).toBe("billing");
    });

    it("classifies the plan-not-included gate as billing", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr:
          "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      });
      expect(info?.kind).toBe("billing");
    });
  });

  describe("auth", () => {
    it("classifies a 401 response as auth", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr:
          'unexpected status 401 Unauthorized: {"detail":"Unauthorized"}, url: https://chatgpt.com/backend-api/codex/responses',
      });
      expect(info?.kind).toBe("auth");
    });

    it("classifies an expired refresh token as auth", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr:
          "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      });
      expect(info?.kind).toBe("auth");
    });

    it("classifies the not-logged-in error as auth", () => {
      const info = classifyCodexFailure({ ...failed, stderr: "Not logged in" });
      expect(info?.kind).toBe("auth");
    });

    it("classifies a forced-login-method mismatch as auth", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "ChatGPT login is required for this configuration.",
      });
      expect(info?.kind).toBe("auth");
    });

    it("classifies a missing API key env var as auth", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "Missing environment variable: `OPENAI_API_KEY`.",
      });
      expect(info?.kind).toBe("auth");
    });

    it("classifies a re-run-codex-login hint as auth", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "ChatGPT account ID not available, please re-run `codex login`",
      });
      expect(info?.kind).toBe("auth");
    });

    it("prefers auth over usage_limit when both phrases appear", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "unexpected status 401 Unauthorized: You've hit your usage limit",
      });
      expect(info?.kind).toBe("auth");
    });
  });

  describe("overload and 5xx", () => {
    it("classifies the model-at-capacity message as overloaded", () => {
      const info = classifyCodexFailure({
        ...failed,
        resultText: "Selected model is at capacity. Please try a different model.",
        resultIsError: true,
      });
      expect(info?.kind).toBe("overloaded");
    });

    it("classifies the high-demand 500 message as overloaded", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "We're currently experiencing high demand, which may cause temporary errors.",
      });
      expect(info?.kind).toBe("overloaded");
    });

    it("classifies exhausted retries on a 5xx as overloaded", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "exceeded retry limit, last status: 500 Internal Server Error",
      });
      expect(info?.kind).toBe("overloaded");
    });

    it("classifies an unexpected 5xx status as overloaded", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: "unexpected status 502 Bad Gateway: upstream connect error",
      });
      expect(info?.kind).toBe("overloaded");
    });

    it("classifies a passed-through server_is_overloaded code as overloaded", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: 'response.failed: {"code":"server_is_overloaded"}',
      });
      expect(info?.kind).toBe("overloaded");
    });
  });

  describe("non-limit failures", () => {
    it("returns undefined for a generic non-zero failure", () => {
      expect(
        classifyCodexFailure({ ...failed, stderr: "TypeError: cannot read properties" }),
      ).toBeUndefined();
    });

    it("returns undefined for the bare turn-failed fallback message", () => {
      expect(
        classifyCodexFailure({ ...failed, resultText: "turn failed", resultIsError: true }),
      ).toBeUndefined();
    });

    it("returns undefined for a generic stream disconnect without a limit reason", () => {
      expect(
        classifyCodexFailure({
          ...failed,
          stderr: "stream disconnected before completion: idle timeout waiting for SSE",
        }),
      ).toBeUndefined();
    });

    it("ignores incidental mentions of rate limits in unrelated failure output", () => {
      expect(
        classifyCodexFailure({
          ...failed,
          resultText: "The downstream API applies a rate limit per client; added caching.",
          resultIsError: true,
        }),
      ).toBeUndefined();
    });

    it("ignores incidental HTTP 429 mentions that are not a CLI status report", () => {
      expect(
        classifyCodexFailure({
          ...failed,
          resultText: "Added handling for HTTP 429 responses in the client.",
          resultIsError: true,
        }),
      ).toBeUndefined();
    });

    it("returns undefined for empty output", () => {
      expect(classifyCodexFailure({ exitCode: 1, stderr: "   " })).toBeUndefined();
    });

    it("never classifies a successful session, even when its text mentions limits", () => {
      expect(
        classifyCodexFailure({
          exitCode: 0,
          stderr: "",
          resultText: "Implemented You've hit your usage limit handling",
          resultIsError: false,
        }),
      ).toBeUndefined();
    });

    it("classifies an is_error result even when the exit code is zero", () => {
      const info = classifyCodexFailure({
        exitCode: 0,
        stderr: "",
        resultText: "You've hit your usage limit. Try again later.",
        resultIsError: true,
      });
      expect(info?.kind).toBe("usage_limit");
    });
  });

  describe("rawSnippet", () => {
    it("captures the matching line, capped in length", () => {
      const long = `You've hit your usage limit. Try again later. ${"x".repeat(500)}`;
      const info = classifyCodexFailure({ ...failed, stderr: `noise before\n${long}` });
      expect(info?.rawSnippet.startsWith("You've hit your usage limit")).toBe(true);
      expect(info?.rawSnippet.length).toBeLessThanOrEqual(300);
    });

    it("redacts secrets echoed alongside the failure", () => {
      const info = classifyCodexFailure({
        ...failed,
        stderr: `unexpected status 401 Unauthorized (key: sk-proj-${"a".repeat(24)})`,
      });
      expect(info?.kind).toBe("auth");
      expect(info?.rawSnippet).not.toContain("sk-proj-");
      expect(info?.rawSnippet).toContain("[REDACTED]");
    });
  });
});
