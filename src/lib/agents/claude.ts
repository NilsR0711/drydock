import { estimateCost } from "@/lib/orchestrator/pricing";
import { StreamJsonParser } from "@/lib/stream/parser";
import { classifyClaudeFailure } from "./claude-limits";
import type { AgentProvider } from "./types";

/** CI-fix resume runs on Haiku with a tighter turn budget (SPEC §6.3). */
export const CLAUDE_RESUME_MODEL = "claude-haiku-4-5";
export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";

/**
 * The `--max-turns` flag, or nothing when the budget is 0 (unlimited, issue
 * #254). A positive budget caps the session; 0 means "no cap", which the CLI
 * expresses by the flag's absence — passing `--max-turns 0` would instead be a
 * zero-turn budget that aborts immediately.
 */
function turnBudgetArgs(maxTurns: number): string[] {
  return maxTurns > 0 ? ["--max-turns", String(maxTurns)] : [];
}

/**
 * The Claude Code CLI as an AgentProvider. This is the behavior-preserving move
 * of the original hardcoded claude logic behind the abstraction: the args here
 * match the SPEC §6.2 / §6.3 invocations exactly.
 */
export const claudeProvider: AgentProvider = {
  id: "claude",
  label: "Claude Code",
  defaultCommand: "claude",
  supportsResume: true,
  resumeModel: CLAUDE_RESUME_MODEL,
  resumeMaxTurns: 15,
  defaultModel: CLAUDE_DEFAULT_MODEL,

  buildStartArgs: ({ prompt, model, maxTurns, bypassPermissions }) => [
    "-p",
    prompt,
    // 0 = unlimited (issue #254): drop the flag entirely so the CLI applies no
    // turn cap, rather than passing `--max-turns 0` (a zero-turn budget).
    ...turnBudgetArgs(maxTurns),
    // An agent-driven release (issue #256) must run the repo's release commands
    // itself, so it bypasses permissions entirely; every other run stays
    // edits-only (acceptEdits), where bash/gh/git would block headlessly.
    ...(bypassPermissions
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "acceptEdits"]),
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ],

  buildResumeArgs: ({ prompt, sessionId, model, maxTurns, bypassPermissions }) => [
    "-p",
    prompt,
    "--resume",
    sessionId,
    ...turnBudgetArgs(maxTurns),
    // Symmetric with buildStartArgs (issue #256): a resumed release session keeps
    // its full shell access. Off for the CI-fix/limit resumes that never set it.
    ...(bypassPermissions ? ["--dangerously-skip-permissions"] : []),
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ],

  // One-shot text prompt (issue #49): print mode without stream-json, so the
  // caller gets the plain final answer to parse a JSON array out of.
  buildOneShotArgs: ({ prompt, model }) => ["-p", prompt, "--model", model],

  // Cost-tracked one-shot: same as start args but without --max-turns and
  // --permission-mode, since one-shots don't edit files and exit after one turn.
  buildStreamOneShotArgs: ({ prompt, model }) => [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ],

  createParser: () => new StreamJsonParser(),

  // Limit/auth detection from CLI output (issue #166): lets the orchestrator
  // park-and-resume on transient quota exhaustion instead of paging a human.
  classifyFailure: classifyClaudeFailure,

  estimateCost,
};
