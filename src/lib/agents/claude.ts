import { estimateCost } from "@/lib/orchestrator/pricing";
import { StreamJsonParser } from "@/lib/stream/parser";
import type { AgentProvider } from "./types";

/** CI-fix resume runs on Haiku with a tighter turn budget (SPEC §6.3). */
export const CLAUDE_RESUME_MODEL = "claude-haiku-4-5";
export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";

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

  buildStartArgs: ({ prompt, model, maxTurns }) => [
    "-p",
    prompt,
    "--max-turns",
    String(maxTurns),
    "--permission-mode",
    "acceptEdits",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ],

  buildResumeArgs: ({ prompt, sessionId, model, maxTurns }) => [
    "-p",
    prompt,
    "--resume",
    sessionId,
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ],

  // One-shot text prompt (issue #49): print mode without stream-json, so the
  // caller gets the plain final answer to parse a JSON array out of.
  buildOneShotArgs: ({ prompt, model }) => ["-p", prompt, "--model", model],

  createParser: () => new StreamJsonParser(),

  estimateCost,
};
