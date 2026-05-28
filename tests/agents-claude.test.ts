import { describe, expect, it } from "vitest";
import { claudeProvider } from "@/lib/agents/claude";

describe("claudeProvider", () => {
  it("identifies itself as the claude agent", () => {
    expect(claudeProvider.id).toBe("claude");
    expect(claudeProvider.defaultCommand).toBe("claude");
    expect(claudeProvider.supportsResume).toBe(true);
  });

  it("builds the SPEC §6.2 start invocation", () => {
    const args = claudeProvider.buildStartArgs({
      prompt: "do it",
      model: "claude-sonnet-4-5",
      maxTurns: 40,
    });
    expect(args).toEqual([
      "-p",
      "do it",
      "--max-turns",
      "40",
      "--permission-mode",
      "acceptEdits",
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("builds the SPEC §6.3 resume invocation with the recorded session id", () => {
    const args = claudeProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "sess-abc",
      model: claudeProvider.resumeModel,
      maxTurns: 15,
    });
    expect(args).not.toBeNull();
    expect(args).toContain("--resume");
    expect(args).toContain("sess-abc");
    expect(args).toContain("claude-haiku-4-5");
  });

  it("builds a plain one-shot invocation for a text prompt (issue #49)", () => {
    const args = claudeProvider.buildOneShotArgs({
      prompt: "split this issue",
      model: "claude-opus-4-7",
    });
    // A one-shot decomposition wants the plain text answer (parsed for a JSON
    // array), so no `--output-format stream-json` here — just `-p` and `--model`.
    expect(args).toEqual(["-p", "split this issue", "--model", "claude-opus-4-7"]);
    expect(args).not.toContain("--output-format");
  });

  it("creates a fresh stream parser that reads stream-json output", () => {
    const parser = claudeProvider.createParser();
    const events = parser.push(
      `${JSON.stringify({ type: "system", session_id: "s1", model: "claude-haiku-4-5" })}\n`,
    );
    expect(events).toHaveLength(1);
    expect(parser.sessionId).toBe("s1");
  });

  it("estimates cost from the claude pricing table", () => {
    // 1M input tokens @ $1/MTok for Haiku.
    expect(claudeProvider.estimateCost("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(1);
  });
});
