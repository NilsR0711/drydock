import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexStreamParser, codexProvider, codexRateLimitReading } from "@/lib/agents/codex";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/codex/${name}`, import.meta.url)), "utf8");
}

/**
 * Codex reports its OAuth quota proactively in the `codex exec --json` stream
 * (issue #189). The rate-limit window numbers ride on a `token_count` event as
 * `rate_limits.{primary,secondary}.{used_percent,window_minutes,resets_in_seconds}`.
 * Field names verified against the Codex CLI JSONL schema (openai/codex #14728).
 */
describe("codexRateLimitReading", () => {
  it("extracts the primary and secondary windows from a token_count event", () => {
    const event = {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 8940 },
        secondary: { used_percent: 12, window_minutes: 10080, resets_in_seconds: 421200 },
      },
    };
    expect(codexRateLimitReading(event)).toEqual({
      primary: { usedPercent: 42.5, windowMinutes: 300, resetsInSeconds: 8940 },
      secondary: { usedPercent: 12, windowMinutes: 10080, resetsInSeconds: 421200 },
    });
  });

  it("returns the primary window when only it is reported", () => {
    const event = { type: "token_count", rate_limits: { primary: { used_percent: 8 } } };
    expect(codexRateLimitReading(event)).toEqual({
      primary: { usedPercent: 8, windowMinutes: undefined, resetsInSeconds: undefined },
      secondary: undefined,
    });
  });

  it("tolerates a null rate_limits (exec mode without quota headers)", () => {
    expect(codexRateLimitReading({ type: "token_count", rate_limits: null })).toBeUndefined();
  });

  it("tolerates an event with no rate_limits field (older CLI)", () => {
    expect(codexRateLimitReading({ type: "turn.completed" })).toBeUndefined();
  });

  it("ignores a window that carries no used_percent number", () => {
    const event = {
      type: "token_count",
      rate_limits: { primary: { window_minutes: 300 }, secondary: { used_percent: 5 } },
    };
    expect(codexRateLimitReading(event)).toEqual({
      primary: undefined,
      secondary: { usedPercent: 5, windowMinutes: undefined, resetsInSeconds: undefined },
    });
  });

  it("returns undefined when neither window has a usable reading", () => {
    const event = { type: "token_count", rate_limits: { primary: {}, secondary: null } };
    expect(codexRateLimitReading(event)).toBeUndefined();
  });
});

describe("CodexStreamParser rate-limit capture", () => {
  it("keeps the latest usable rate-limit snapshot seen in the stream", () => {
    const parser = new CodexStreamParser();
    parser.push(fixture("rate-limits.jsonl"));
    parser.flush();
    expect(parser.rateLimits).toEqual({
      primary: { usedPercent: 42.5, windowMinutes: 300, resetsInSeconds: 8940 },
      secondary: { usedPercent: 12, windowMinutes: 10080, resetsInSeconds: 421200 },
    });
  });

  it("leaves rateLimits undefined for a stream without quota data", () => {
    const parser = new CodexStreamParser();
    parser.push(fixture("success.jsonl"));
    parser.flush();
    expect(parser.rateLimits).toBeUndefined();
  });
});

describe("codexProvider.captureUsage", () => {
  it("surfaces the parser's rate-limit reading for persistence", () => {
    const parser = new CodexStreamParser();
    parser.push(fixture("rate-limits.jsonl"));
    parser.flush();
    expect(codexProvider.captureUsage?.(parser)).toEqual(parser.rateLimits);
  });

  it("returns undefined when the stream reported no quota data", () => {
    const parser = new CodexStreamParser();
    parser.push(fixture("success.jsonl"));
    parser.flush();
    expect(codexProvider.captureUsage?.(parser)).toBeUndefined();
  });
});
