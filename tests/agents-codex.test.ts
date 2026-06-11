import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexStreamParser, codexProvider } from "@/lib/agents/codex";
import type { ParseError } from "@/lib/stream/parser";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/codex/${name}`, import.meta.url)), "utf8");
}

describe("codexProvider", () => {
  it("identifies itself as the codex agent", () => {
    expect(codexProvider.id).toBe("codex");
    expect(codexProvider.defaultCommand).toBe("codex");
    expect(codexProvider.supportsResume).toBe(true);
  });

  it("classifies limit failures via classifyFailure (issue #167)", () => {
    const info = codexProvider.classifyFailure?.({
      exitCode: 1,
      stderr: "",
      resultText: "You've hit your usage limit. Try again at 9:01 PM.",
      resultIsError: true,
    });
    expect(info).toMatchObject({ agent: "codex", kind: "usage_limit" });
  });

  it("builds a non-interactive exec invocation with JSON output and a writable sandbox", () => {
    const args = codexProvider.buildStartArgs({
      prompt: "fix the bug",
      model: "gpt-5-codex",
      maxTurns: 40,
    });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5-codex");
    // The prompt is the trailing positional argument.
    expect(args.at(-1)).toBe("fix the bug");
  });

  it("does not inject a turn-budget flag on start (codex exec has no --max-turns, issue #48)", () => {
    // `codex exec` runs a single turn (TurnStart → TurnCompleted) and exposes no
    // turn-budget flag or config key, unlike Claude's `--max-turns`. Passing one
    // would be ignored, or rejected under `--strict-config`. A runaway run is
    // bounded by the orchestrator's wall-clock timeout (issue #47), not by turns.
    const args = codexProvider.buildStartArgs({
      prompt: "fix the bug",
      model: "gpt-5-codex",
      maxTurns: 40,
    });
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--max-steps");
    expect(args).not.toContain("max_turns");
    // The budget must not leak in as a positional or `-c key=value` value either.
    expect(args).not.toContain("40");
    expect(args.some((a) => a.includes("max_turns"))).toBe(false);
  });

  it("does not inject a turn-budget flag on resume either (issue #48)", () => {
    const args = codexProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "th_codex_abc",
      model: codexProvider.resumeModel,
      maxTurns: codexProvider.resumeMaxTurns,
    });
    expect(args).not.toBeNull();
    expect(args).not.toContain("--max-turns");
    expect(args?.some((a) => a.includes("max_turns"))).toBe(false);
    expect(args).not.toContain(String(codexProvider.resumeMaxTurns));
  });

  it("builds a non-streaming one-shot exec invocation for a text prompt (issue #49)", () => {
    const args = codexProvider.buildOneShotArgs({
      prompt: "split this issue",
      model: "gpt-5-codex",
    });
    // codex one-shots run via `exec`, not Claude's `-p`, and take the prompt as
    // the trailing positional. No `--json`: decomposition wants the plain final
    // message, parsed for a JSON array, not the JSONL event stream.
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--json");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5-codex");
    expect(args.at(-1)).toBe("split this issue");
  });

  it("builds a resume invocation targeting the recorded thread id", () => {
    const args = codexProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "th_codex_abc",
      model: codexProvider.resumeModel,
      maxTurns: 15,
    });
    expect(args).not.toBeNull();
    expect(args?.slice(0, 3)).toEqual(["exec", "resume", "th_codex_abc"]);
    expect(args).toContain("--json");
    expect(args?.at(-1)).toBe("fix ci");
  });

  it("estimates cost from the codex pricing table", () => {
    // 1M input @ $1.25 + 1M output @ $10 for gpt-5-codex.
    expect(codexProvider.estimateCost("gpt-5-codex", 1_000_000, 1_000_000)).toBeCloseTo(11.25);
  });
});

describe("CodexStreamParser", () => {
  it("captures the thread id from thread.started as the session id", () => {
    const p = new CodexStreamParser();
    const events = [...p.push(fixture("success.jsonl")), ...p.flush()];
    expect(p.sessionId).toBe("th_codex_abc");
    expect(events[0]?.type).toBe("system");
    expect(events[0]?.sessionId).toBe("th_codex_abc");
  });

  it("maps completed items to normalized chunks", () => {
    const p = new CodexStreamParser();
    const events = [...p.push(fixture("success.jsonl")), ...p.flush()];
    const chunks = events.flatMap((e) => e.chunks);
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);
    expect(texts).toContain("Fixed the off-by-one error.");
    const toolUses = chunks.filter((c) => c.kind === "tool_use").map((c) => c.name);
    expect(toolUses).toContain("command");
    expect(toolUses).toContain("edit");
  });

  it("accumulates token usage from turn.completed, counting reasoning as output", () => {
    const p = new CodexStreamParser();
    [...p.push(fixture("success.jsonl")), ...p.flush()];
    expect(p.totalInputTokens).toBe(12000);
    // output_tokens (1500) + reasoning_output_tokens (500)
    expect(p.totalOutputTokens).toBe(2000);
    // Codex does not report a USD cost in its stream.
    expect(p.costUsd).toBe(0);
  });

  it("ignores started/in-progress events so chunks are not duplicated", () => {
    const p = new CodexStreamParser();
    const events = [...p.push(fixture("success.jsonl")), ...p.flush()];
    // thread.started + 5 item.completed + turn.completed = 7 normalized events
    expect(events).toHaveLength(7);
  });

  it("flags a failed turn via isError on a result event", () => {
    const p = new CodexStreamParser();
    const events = [
      ...p.push(`${JSON.stringify({ type: "turn.failed", error: { message: "boom" } })}\n`),
      ...p.flush(),
    ];
    expect(events.at(-1)?.type).toBe("result");
    expect(events.at(-1)?.isError).toBe(true);
  });

  it("captures the turn.failed error message as the result text (issue #167)", () => {
    const p = new CodexStreamParser();
    const line = JSON.stringify({
      type: "turn.failed",
      error: { message: "You've hit your usage limit. Try again at 9:01 PM." },
    });
    [...p.push(`${line}\n`), ...p.flush()];
    expect(p.resultIsError).toBe(true);
    expect(p.resultText).toBe("You've hit your usage limit. Try again at 9:01 PM.");
  });

  it("captures a fatal stream error event's message as the result text", () => {
    const p = new CodexStreamParser();
    const line = JSON.stringify({
      type: "error",
      message: "stream disconnected before completion: Rate limit reached for gpt-5-codex",
    });
    [...p.push(`${line}\n`), ...p.flush()];
    expect(p.resultIsError).toBe(true);
    expect(p.resultText).toContain("Rate limit reached");
  });

  it("clears the error result when a later turn completes (transient reconnect notices)", () => {
    // The CLI emits non-fatal `error` events (e.g. "Reconnecting... 1/5") that
    // do not fail the turn; a subsequent turn.completed must win.
    const p = new CodexStreamParser();
    const lines = [
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (stream error)" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join("\n");
    [...p.push(`${lines}\n`), ...p.flush()];
    expect(p.resultIsError).toBe(false);
    expect(p.resultText).toBeUndefined();
  });

  it("keeps resultIsError set on a turn.failed without an error message", () => {
    const p = new CodexStreamParser();
    [...p.push(`${JSON.stringify({ type: "turn.failed" })}\n`), ...p.flush()];
    expect(p.resultIsError).toBe(true);
    expect(p.resultText).toBeUndefined();
  });

  it("skips a malformed JSON line without throwing or crashing (issue #46)", () => {
    const p = new CodexStreamParser();
    expect(() => p.push("{not json\n")).not.toThrow();
  });

  it("skips a malformed line yet still parses subsequent valid lines", () => {
    const p = new CodexStreamParser();
    const valid = JSON.stringify({ type: "thread.started", thread_id: "th_after_garbage" });
    const events = [...p.push(`codex startup banner\n${valid}\n`), ...p.flush()];
    expect(events).toHaveLength(1);
    expect(p.sessionId).toBe("th_after_garbage");
  });

  it("reports each skipped line through the onParseError callback", () => {
    const p = new CodexStreamParser();
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
    const p = new CodexStreamParser();
    const events = [...p.push(raw.slice(0, mid)), ...p.push(raw.slice(mid)), ...p.flush()];
    expect(events).toHaveLength(7);
    expect(p.sessionId).toBe("th_codex_abc");
  });
});
