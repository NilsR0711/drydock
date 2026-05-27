import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexStreamParser, codexProvider } from "@/lib/agents/codex";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/codex/${name}`, import.meta.url)), "utf8");
}

describe("codexProvider", () => {
  it("identifies itself as the codex agent", () => {
    expect(codexProvider.id).toBe("codex");
    expect(codexProvider.defaultCommand).toBe("codex");
    expect(codexProvider.supportsResume).toBe(true);
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

  it("throws on malformed JSON", () => {
    const p = new CodexStreamParser();
    expect(() => p.push("{not json\n")).toThrow();
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
