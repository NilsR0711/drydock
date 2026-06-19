import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ParseError } from "@/lib/stream/parser";
import { parseLine, StreamJsonParser } from "@/lib/stream/parser";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/stream-json/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("parseLine", () => {
  it("returns null for blank lines", () => {
    expect(parseLine("   ")).toBeNull();
  });

  it("extracts session id + model from system event", () => {
    const e = parseLine('{"type":"system","session_id":"s1","model":"claude-sonnet-4-5"}');
    expect(e?.sessionId).toBe("s1");
    expect(e?.model).toBe("claude-sonnet-4-5");
  });

  it("extracts tool_use chunks from assistant events", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { f: 1 } }],
      },
    });
    const e = parseLine(line);
    expect(e?.chunks[0]).toMatchObject({ kind: "tool_use", name: "Read", id: "t1" });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseLine("{not json")).toThrow();
  });

  it("extracts rate-limit info from a rate_limit_event (issue #188)", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1_781_754_000,
        rateLimitType: "five_hour",
      },
      session_id: "s1",
    });
    const e = parseLine(line);
    expect(e?.type).toBe("rate_limit_event");
    expect(e?.rateLimitInfo).toMatchObject({
      status: "allowed",
      resetsAt: 1_781_754_000,
      rateLimitType: "five_hour",
    });
  });
});

describe("StreamJsonParser against fixtures", () => {
  it("parses the successful run and accumulates cost/tokens", () => {
    const p = new StreamJsonParser();
    const events = [...p.push(fixture("success.ndjson")), ...p.flush()];
    expect(events.length).toBe(22);
    expect(p.sessionId).toBe("sess-abc-123");
    expect(p.model).toBe("claude-sonnet-4-5");
    expect(p.costUsd).toBeCloseTo(0.0421);
    expect(events.at(-1)?.type).toBe("result");
    expect(events.at(-1)?.isError).toBe(false);
  });

  it("reports the result event's session-total usage without double-counting (issue #87)", () => {
    const p = new StreamJsonParser();
    [...p.push(fixture("success.ndjson")), ...p.flush()];
    // The result event's usage is the authoritative session total; it must be
    // assigned, not added on top of the per-assistant-turn usages.
    expect(p.totalInputTokens).toBe(15300);
    expect(p.totalOutputTokens).toBe(2200);
  });

  it("retains per-turn token accumulation when the result omits usage", () => {
    const p = new StreamJsonParser();
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 120, output_tokens: 40 },
      },
    });
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    [...p.push(`${assistant}\n${result}\n`), ...p.flush()];
    expect(p.totalInputTokens).toBe(120);
    expect(p.totalOutputTokens).toBe(40);
  });

  it("parses the tool-use heavy run", () => {
    const p = new StreamJsonParser();
    const events = [...p.push(fixture("tool-use.ndjson")), ...p.flush()];
    const toolUses = events.flatMap((e) => e.chunks).filter((c) => c.kind === "tool_use");
    expect(toolUses.length).toBeGreaterThanOrEqual(14);
    expect(p.costUsd).toBeCloseTo(0.0712);
  });

  it("flags the error run via is_error on the result", () => {
    const p = new StreamJsonParser();
    const events = [...p.push(fixture("error.ndjson")), ...p.flush()];
    const result = events.at(-1);
    expect(result?.type).toBe("result");
    expect(result?.isError).toBe(true);
  });

  it("exposes the result event's text and error flag for failure classification (issue #166)", () => {
    const p = new StreamJsonParser();
    [...p.push(fixture("usage-limit.ndjson")), ...p.flush()];
    expect(p.resultText).toBe("Claude AI usage limit reached|1749924000");
    expect(p.resultIsError).toBe(true);
  });

  it("leaves resultText/resultIsError unset until a result arrives", () => {
    const p = new StreamJsonParser();
    p.push('{"type":"system","session_id":"s1"}\n');
    expect(p.resultText).toBeUndefined();
    expect(p.resultIsError).toBe(false);
  });

  it("exposes the result event's subtype for outcome classification (issue #277)", () => {
    const p = new StreamJsonParser();
    const result = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    });
    const events = [...p.push(`${result}\n`), ...p.flush()];
    expect(events.at(-1)?.resultSubtype).toBe("error_max_turns");
    expect(p.resultSubtype).toBe("error_max_turns");
    expect(p.resultIsError).toBe(true);
  });

  it("leaves resultSubtype unset until a result arrives (issue #277)", () => {
    const p = new StreamJsonParser();
    p.push('{"type":"system","session_id":"s1"}\n');
    expect(p.resultSubtype).toBeUndefined();
  });

  it("handles chunk boundaries that split a line", () => {
    const raw = fixture("success.ndjson");
    const mid = Math.floor(raw.length / 2);
    const p = new StreamJsonParser();
    const events = [...p.push(raw.slice(0, mid)), ...p.push(raw.slice(mid)), ...p.flush()];
    expect(events.length).toBe(22);
  });
});

describe("StreamJsonParser cache token tracking (issue #95)", () => {
  it("extracts cache_creation_input_tokens from an assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 500 },
      },
    });
    const e = parseLine(line);
    expect(e?.cacheCreationInputTokens).toBe(500);
    expect(e?.cacheReadInputTokens).toBe(0);
  });

  it("extracts cache_read_input_tokens from an assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 80, output_tokens: 10, cache_read_input_tokens: 2000 },
      },
    });
    const e = parseLine(line);
    expect(e?.cacheReadInputTokens).toBe(2000);
    expect(e?.cacheCreationInputTokens).toBe(0);
  });

  it("extracts cache tokens from a result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.01,
      usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 5000 },
    });
    const e = parseLine(line);
    expect(e?.cacheReadInputTokens).toBe(5000);
  });

  it("accumulates totalCacheCreationInputTokens across assistant events", () => {
    const p = new StreamJsonParser();
    const turn = (cacheWrite: number) =>
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: cacheWrite },
        },
      });
    p.push(`${turn(300)}\n${turn(200)}\n`);
    expect(p.totalCacheCreationInputTokens).toBe(500);
  });

  it("assigns totalCacheReadInputTokens from the result event (authoritative session total)", () => {
    const p = new StreamJsonParser();
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      },
    });
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8000 },
    });
    p.push(`${assistantLine}\n${resultLine}\n`);
    // Result event is authoritative — should override accumulated value
    expect(p.totalCacheReadInputTokens).toBe(8000);
  });

  it("assigns totalCacheCreationInputTokens from the result event (authoritative session total)", () => {
    const p = new StreamJsonParser();
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 200 },
      },
    });
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 4000 },
    });
    p.push(`${assistantLine}\n${resultLine}\n`);
    // Result event is authoritative — should override accumulated value
    expect(p.totalCacheCreationInputTokens).toBe(4000);
  });

  it("retains per-turn cache accumulation when result omits cache fields", () => {
    const p = new StreamJsonParser();
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 120,
        },
      },
    });
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    p.push(`${assistantLine}\n${resultLine}\n`);
    expect(p.totalCacheReadInputTokens).toBe(300);
    expect(p.totalCacheCreationInputTokens).toBe(120);
  });
});

describe("StreamJsonParser malformed input resilience (issue #46)", () => {
  it("does not throw when a non-JSON line is pushed", () => {
    const p = new StreamJsonParser();
    expect(() => p.push("npm warn deprecated foo@1.0.0\n")).not.toThrow();
  });

  it("skips a malformed line yet still parses subsequent valid lines", () => {
    const p = new StreamJsonParser();
    const valid = '{"type":"system","session_id":"s1","model":"claude-sonnet-4-5"}';
    const events = [...p.push(`garbage banner line\n${valid}\n`), ...p.flush()];
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe("s1");
    expect(p.sessionId).toBe("s1");
  });

  it("skips a line whose JSON shape fails schema validation", () => {
    const p = new StreamJsonParser();
    // Valid JSON, but an unknown discriminator the Zod union rejects.
    const events = [...p.push('{"type":"telemetry","foo":1}\n'), ...p.flush()];
    expect(events).toHaveLength(0);
  });

  it("reports each skipped line through the onParseError callback", () => {
    const p = new StreamJsonParser();
    const errors: ParseError[] = [];
    p.onParseError = (e) => errors.push(e);
    p.push("not json at all\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe("not json at all");
    expect(errors[0]?.message).toBeTruthy();
  });

  it("does not throw on a malformed trailing line flushed at exit", () => {
    const p = new StreamJsonParser();
    p.push("partial banner without newline");
    expect(() => p.flush()).not.toThrow();
  });

  it("retains the latest rate_limit_event info on the parser (issue #188)", () => {
    const p = new StreamJsonParser();
    p.push(
      `${JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 100, rateLimitType: "five_hour" },
      })}\n`,
    );
    p.push(
      `${JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", resetsAt: 200, rateLimitType: "five_hour" },
      })}\n`,
    );
    expect(p.rateLimit).toMatchObject({ status: "allowed_warning", resetsAt: 200 });
  });

  it("treats a rate_limit_event as a real event, not a parse error (issue #188)", () => {
    const p = new StreamJsonParser();
    const errors: ParseError[] = [];
    p.onParseError = (e) => errors.push(e);
    const events = p.push(
      `${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })}\n`,
    );
    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("parses a JSON object split across two chunks once complete", () => {
    const p = new StreamJsonParser();
    const line = '{"type":"system","session_id":"split","model":"m"}\n';
    const cut = 20;
    // The first half is not valid JSON on its own; it must not be parsed early.
    const first = p.push(line.slice(0, cut));
    expect(first).toHaveLength(0);
    const second = p.push(line.slice(cut));
    expect(second).toHaveLength(1);
    expect(second[0]?.sessionId).toBe("split");
  });
});
