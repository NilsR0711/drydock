import { describe, expect, it } from "vitest";
import { openrouterProvider } from "@/lib/agents/openrouter";
import {
  classifyOpenRouterFailure,
  classifyOpenRouterHttpError,
} from "@/lib/agents/openrouter-limits";
import { AGENT_IDS, getAgentProvider, isAgentId } from "@/lib/agents/registry";
import { defaultModelForAgent, modelsForAgent } from "@/lib/models";
import { OpenRouterHttpError } from "@/lib/openrouter/client";

describe("openrouterProvider (issue #169)", () => {
  it("identifies itself as an HTTP-backed agent", () => {
    expect(openrouterProvider.id).toBe("openrouter");
    expect(openrouterProvider.kind).toBe("http");
    expect(openrouterProvider.label).toBe("OpenRouter");
    expect(openrouterProvider.supportsResume).toBe(false);
    expect(openrouterProvider.defaultModel).toBe("");
  });

  it("has no resume or stream-one-shot CLI surface", () => {
    expect(
      openrouterProvider.buildResumeArgs({ prompt: "p", model: "m", maxTurns: 1, sessionId: "s" }),
    ).toBeNull();
    expect(openrouterProvider.buildStreamOneShotArgs({ prompt: "p", model: "m" })).toBeNull();
  });

  it("refuses CLI argument building and parsing outright", () => {
    expect(() =>
      openrouterProvider.buildStartArgs({ prompt: "p", model: "m", maxTurns: 1 }),
    ).toThrow(/http/i);
    expect(() => openrouterProvider.buildOneShotArgs({ prompt: "p", model: "m" })).toThrow(/http/i);
    expect(() => openrouterProvider.createParser()).toThrow(/http/i);
  });

  it("reports zero estimated cost (the session runner prices via the catalog)", () => {
    expect(openrouterProvider.estimateCost("any/model", 1000, 1000)).toBe(0);
  });

  it("is registered as a third agent", () => {
    expect(AGENT_IDS).toContain("openrouter");
    expect(isAgentId("openrouter")).toBe(true);
    expect(getAgentProvider("openrouter").id).toBe("openrouter");
  });

  it("has no static model list — the synced catalog is the source", () => {
    expect(modelsForAgent("openrouter")).toEqual([]);
    expect(defaultModelForAgent("openrouter")).toBe("");
  });
});

describe("classifyOpenRouterFailure (issue #169)", () => {
  const base = { exitCode: 1, stderr: "" };

  it("never classifies a successful session", () => {
    expect(
      classifyOpenRouterFailure({ exitCode: 0, stderr: "OpenRouter HTTP 429: rate limited" }),
    ).toBeUndefined();
  });

  it("classifies 429 as rate_limit with a retry-after hint", () => {
    const info = classifyOpenRouterFailure({
      ...base,
      stderr: "OpenRouter HTTP 429: Rate limit exceeded (retry after 30s)",
    });
    expect(info).toMatchObject({ agent: "openrouter", kind: "rate_limit", retryAfterMs: 30_000 });
  });

  it("classifies free-tier daily quota exhaustion as usage_limit", () => {
    const info = classifyOpenRouterFailure({
      ...base,
      stderr: "OpenRouter HTTP 429: Rate limit exceeded: free-models-per-day",
    });
    expect(info?.kind).toBe("usage_limit");
  });

  it("classifies 401/403 as auth and 402 as billing", () => {
    expect(
      classifyOpenRouterFailure({ ...base, stderr: "OpenRouter HTTP 401: No auth credentials" })
        ?.kind,
    ).toBe("auth");
    expect(
      classifyOpenRouterFailure({ ...base, stderr: "OpenRouter HTTP 403: Key limit exceeded" })
        ?.kind,
    ).toBe("auth");
    expect(
      classifyOpenRouterFailure({ ...base, stderr: "OpenRouter HTTP 402: Insufficient credits" })
        ?.kind,
    ).toBe("billing");
  });

  it("classifies 5xx and 408 as overloaded", () => {
    expect(
      classifyOpenRouterFailure({ ...base, stderr: "OpenRouter HTTP 502: Provider error" })?.kind,
    ).toBe("overloaded");
    expect(
      classifyOpenRouterFailure({ ...base, stderr: "OpenRouter HTTP 408: Timed out" })?.kind,
    ).toBe("overloaded");
  });

  it("returns undefined for failures without a provider signal", () => {
    expect(
      classifyOpenRouterFailure({ ...base, stderr: "tool loop exceeded turns" }),
    ).toBeUndefined();
  });
});

describe("classifyOpenRouterHttpError (issue #169)", () => {
  it("maps a structured 429 with retry-after", () => {
    const info = classifyOpenRouterHttpError(
      new OpenRouterHttpError(429, "Rate limit exceeded", 15_000),
    );
    expect(info).toMatchObject({ agent: "openrouter", kind: "rate_limit", retryAfterMs: 15_000 });
    expect(info?.rawSnippet).toContain("429");
  });

  it("maps 402 to billing and 401 to auth", () => {
    expect(
      classifyOpenRouterHttpError(new OpenRouterHttpError(402, "Insufficient credits"))?.kind,
    ).toBe("billing");
    expect(classifyOpenRouterHttpError(new OpenRouterHttpError(401, "bad key"))?.kind).toBe("auth");
  });

  it("maps 5xx to overloaded and leaves 400 unclassified", () => {
    expect(classifyOpenRouterHttpError(new OpenRouterHttpError(503, "down"))?.kind).toBe(
      "overloaded",
    );
    expect(
      classifyOpenRouterHttpError(new OpenRouterHttpError(400, "bad request")),
    ).toBeUndefined();
  });

  it("redacts secrets from the persisted snippet", () => {
    const info = classifyOpenRouterHttpError(
      new OpenRouterHttpError(429, `limited for key sk-or-v1-${"a".repeat(64)}`),
    );
    expect(info?.rawSnippet).not.toContain("a".repeat(64));
    expect(info?.rawSnippet).toContain("[REDACTED]");
  });
});
