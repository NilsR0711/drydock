import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpencodeStreamParser, opencodeProvider } from "@/lib/agents/opencode";
import type { ParseError } from "@/lib/stream/parser";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/opencode/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("opencodeProvider", () => {
  it("identifies itself as the opencode CLI agent", () => {
    expect(opencodeProvider.id).toBe("opencode");
    expect(opencodeProvider.kind ?? "cli").toBe("cli");
    expect(opencodeProvider.defaultCommand).toBe("opencode");
    expect(opencodeProvider.supportsResume).toBe(true);
  });

  it("builds a headless run invocation with JSON output and an explicit model", () => {
    const args = opencodeProvider.buildStartArgs({
      prompt: "fix the bug",
      model: "anthropic/claude-sonnet-4-6",
      maxTurns: 40,
    });
    expect(args[0]).toBe("run");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("--model");
    expect(args).toContain("anthropic/claude-sonnet-4-6");
    // The prompt is the trailing positional argument.
    expect(args.at(-1)).toBe("fix the bug");
  });

  it("does not inject a turn-budget flag on start (opencode run has no --max-turns)", () => {
    const args = opencodeProvider.buildStartArgs({
      prompt: "fix the bug",
      model: "anthropic/claude-sonnet-4-6",
      maxTurns: 40,
    });
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("40");
  });

  it("runs with opencode's permissive defaults unless permissions are bypassed", () => {
    const normal = opencodeProvider.buildStartArgs({
      prompt: "fix the bug",
      model: "anthropic/claude-sonnet-4-6",
      maxTurns: 0,
    });
    expect(normal).not.toContain("--dangerously-skip-permissions");
    const bypass = opencodeProvider.buildStartArgs({
      prompt: "release",
      model: "anthropic/claude-sonnet-4-6",
      maxTurns: 0,
      bypassPermissions: true,
    });
    expect(bypass).toContain("--dangerously-skip-permissions");
  });

  it("resumes a recorded session without overriding its model", () => {
    const args = opencodeProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "ses_abc",
      model: opencodeProvider.resumeModel,
      maxTurns: opencodeProvider.resumeMaxTurns,
    });
    expect(args).not.toBeNull();
    expect(args?.[0]).toBe("run");
    expect(args).toContain("--session");
    expect(args).toContain("ses_abc");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    // Resume reuses the session's original model — do not force --model.
    expect(args).not.toContain("--model");
    expect(args?.at(-1)).toBe("fix ci");
  });

  it("forwards the permission bypass on resume too", () => {
    const normal = opencodeProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "ses_abc",
      model: opencodeProvider.resumeModel,
      maxTurns: opencodeProvider.resumeMaxTurns,
    });
    expect(normal).not.toContain("--dangerously-skip-permissions");
    const bypass = opencodeProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "ses_abc",
      model: opencodeProvider.resumeModel,
      maxTurns: opencodeProvider.resumeMaxTurns,
      bypassPermissions: true,
    });
    expect(bypass).toContain("--dangerously-skip-permissions");
  });

  it("builds a plain (non-JSON) one-shot for text decomposition", () => {
    const args = opencodeProvider.buildOneShotArgs({
      prompt: "split this issue",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(args[0]).toBe("run");
    expect(args).not.toContain("--format");
    expect(args).toContain("--model");
    expect(args.at(-1)).toBe("split this issue");
  });

  it("builds a cost-tracked JSON one-shot", () => {
    const args = opencodeProvider.buildStreamOneShotArgs({
      prompt: "split this issue",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(args).not.toBeNull();
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args?.at(-1)).toBe("split this issue");
  });

  it("does not estimate cost from tokens — cost comes from the stream", () => {
    // opencode reports per-step USD cost natively; a static table would drift
    // from the live models.dev catalog, so the estimate is always 0.
    expect(opencodeProvider.estimateCost("anthropic/claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(
      0,
    );
  });
});

describe("OpencodeStreamParser", () => {
  it("captures the session id from step_start as the session id", () => {
    const p = new OpencodeStreamParser();
    const events = [...p.push(fixture("success.jsonl")), ...p.flush()];
    expect(p.sessionId).toBe("ses_abc");
    expect(events[0]?.type).toBe("system");
    expect(events[0]?.sessionId).toBe("ses_abc");
  });

  it("maps text and tool_use parts to normalized chunks", () => {
    const p = new OpencodeStreamParser();
    const events = [...p.push(fixture("success.jsonl")), ...p.flush()];
    const chunks = events.flatMap((e) => e.chunks);
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);
    expect(texts).toContain("Fixed the off-by-one error.");
    const toolUses = chunks.filter((c) => c.kind === "tool_use").map((c) => c.name);
    expect(toolUses).toContain("edit");
  });

  it("sums per-step token usage across step_finish events, folding reasoning into output", () => {
    const p = new OpencodeStreamParser();
    [...p.push(fixture("success.jsonl")), ...p.flush()];
    // input: 1000 + 500
    expect(p.totalInputTokens).toBe(1500);
    // output+reasoning: (200+50) + (100+0)
    expect(p.totalOutputTokens).toBe(350);
    // cache write: 100 + 0
    expect(p.totalCacheCreationInputTokens).toBe(100);
    // cache read: 300 + 150
    expect(p.totalCacheReadInputTokens).toBe(450);
  });

  it("sums per-step USD cost across step_finish events", () => {
    const p = new OpencodeStreamParser();
    [...p.push(fixture("success.jsonl")), ...p.flush()];
    expect(p.costUsd).toBeCloseTo(0.003);
  });

  it("surfaces a single terminal result event (only the reason=stop step)", () => {
    const p = new OpencodeStreamParser();
    const events = [...p.push(fixture("success.jsonl")), ...p.flush()];
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    // step_start(system) + 2 text + 1 tool_use(assistant) + 1 result = 5
    expect(events).toHaveLength(5);
  });

  it("flags a failed session via isError and captures the error message", () => {
    const p = new OpencodeStreamParser();
    const line = JSON.stringify({
      type: "error",
      sessionID: "ses_x",
      error: { name: "ProviderError", data: { message: "boom: rate limit reached" } },
    });
    const events = [...p.push(`${line}\n`), ...p.flush()];
    expect(events.at(-1)?.type).toBe("result");
    expect(events.at(-1)?.isError).toBe(true);
    expect(p.resultIsError).toBe(true);
    expect(p.resultText).toContain("rate limit reached");
  });

  it("skips a malformed JSON line without throwing", () => {
    const p = new OpencodeStreamParser();
    expect(() => p.push("opencode startup banner\n")).not.toThrow();
  });

  it("reports each skipped line through the onParseError callback", () => {
    const p = new OpencodeStreamParser();
    const errors: ParseError[] = [];
    p.onParseError = (e) => errors.push(e);
    p.push("not json at all\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe("not json at all");
    expect(errors[0]?.message).toBeTruthy();
  });

  it("handles chunk boundaries that split a line", () => {
    const raw = fixture("success.jsonl");
    const mid = Math.floor(raw.length / 2);
    const p = new OpencodeStreamParser();
    const events = [...p.push(raw.slice(0, mid)), ...p.push(raw.slice(mid)), ...p.flush()];
    expect(events).toHaveLength(5);
    expect(p.sessionId).toBe("ses_abc");
    expect(p.totalInputTokens).toBe(1500);
  });
});
