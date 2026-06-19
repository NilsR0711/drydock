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

  it("swaps acceptEdits for full shell access when bypassPermissions is set (issue #256)", () => {
    // An agent-driven release must run gh/git/npm itself, which acceptEdits
    // blocks headlessly; bypass replaces it with --dangerously-skip-permissions.
    const args = claudeProvider.buildStartArgs({
      prompt: "release it",
      model: "claude-opus-4-8",
      maxTurns: 40,
      bypassPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("acceptEdits");
  });

  it("pre-approves the configured commands via --allowedTools, keeping acceptEdits (issue #329)", () => {
    // A native repo that needs to run git/xcodebuild/simctl headlessly without
    // the all-or-nothing bypass: each command becomes a Bash(<cmd>:*) allow rule
    // layered on top of the default edits-only mode.
    const args = claudeProvider.buildStartArgs({
      prompt: "build it",
      model: "claude-opus-4-8",
      maxTurns: 40,
      allowedCommands: ["git", "xcodebuild", "xcrun", "swift"],
    });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(args.slice(idx + 1, idx + 5)).toEqual([
      "Bash(git:*)",
      "Bash(xcodebuild:*)",
      "Bash(xcrun:*)",
      "Bash(swift:*)",
    ]);
  });

  it("omits --allowedTools entirely when no commands are configured (issue #329)", () => {
    const empty = claudeProvider.buildStartArgs({
      prompt: "do it",
      model: "claude-opus-4-8",
      maxTurns: 40,
      allowedCommands: [],
    });
    expect(empty).not.toContain("--allowedTools");
    // Unset behaves identically to an empty list.
    const unset = claudeProvider.buildStartArgs({
      prompt: "do it",
      model: "claude-opus-4-8",
      maxTurns: 40,
    });
    expect(unset).not.toContain("--allowedTools");
  });

  it("drops --allowedTools under bypass, which already grants all commands (issue #329)", () => {
    // --dangerously-skip-permissions is a superset of any allowlist, so emitting
    // both would be redundant (and acceptEdits is gone). Bypass wins.
    const args = claudeProvider.buildStartArgs({
      prompt: "release it",
      model: "claude-opus-4-8",
      maxTurns: 40,
      bypassPermissions: true,
      allowedCommands: ["git", "xcodebuild"],
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("acceptEdits");
  });

  it("pre-approves the configured commands on resume too (issue #329)", () => {
    // CI-fix / limit / instruction resumes re-run in the worktree and may need
    // the same build commands, so the allowlist applies symmetrically.
    const args = claudeProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "sess-abc",
      model: claudeProvider.resumeModel,
      maxTurns: 15,
      allowedCommands: ["git", "xcodebuild"],
    });
    expect(args).not.toBeNull();
    const idx = (args as string[]).indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect((args as string[]).slice(idx + 1, idx + 3)).toEqual([
      "Bash(git:*)",
      "Bash(xcodebuild:*)",
    ]);
    // Bypass on resume still suppresses the allowlist.
    const bypassed = claudeProvider.buildResumeArgs({
      prompt: "continue",
      sessionId: "sess-abc",
      model: claudeProvider.resumeModel,
      maxTurns: 15,
      bypassPermissions: true,
      allowedCommands: ["git"],
    });
    expect(bypassed).toContain("--dangerously-skip-permissions");
    expect(bypassed).not.toContain("--allowedTools");
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

  it("keeps full shell access on resume when bypassPermissions is set (issue #256)", () => {
    const args = claudeProvider.buildResumeArgs({
      prompt: "continue",
      sessionId: "sess-abc",
      model: claudeProvider.resumeModel,
      maxTurns: 15,
      bypassPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
    // A normal resume (no flag) carries no permission flag at all.
    const plain = claudeProvider.buildResumeArgs({
      prompt: "continue",
      sessionId: "sess-abc",
      model: claudeProvider.resumeModel,
      maxTurns: 15,
    });
    expect(plain).not.toContain("--dangerously-skip-permissions");
  });

  it("omits --max-turns when the budget is 0 (unlimited, issue #254)", () => {
    // 0 = no cap: the flag must be dropped entirely, not passed as
    // `--max-turns 0` (which the CLI would read as a zero-turn budget).
    const start = claudeProvider.buildStartArgs({
      prompt: "do it",
      model: "claude-opus-4-8",
      maxTurns: 0,
    });
    expect(start).not.toContain("--max-turns");
    expect(start).not.toContain("0");
    expect(start).toContain("-p");
    expect(start).toContain("acceptEdits");

    const resume = claudeProvider.buildResumeArgs({
      prompt: "fix ci",
      sessionId: "sess-xyz",
      model: claudeProvider.resumeModel,
      maxTurns: 0,
    });
    expect(resume).not.toContain("--max-turns");
    expect(resume).toContain("--resume");
    expect(resume).toContain("sess-xyz");
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
