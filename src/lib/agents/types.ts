import type { ParsedEvent, ParseError } from "@/lib/stream/parser";

/** Coding agents Drydock can drive. Each maps to a CLI and an AgentProvider. */
export type AgentId = "claude" | "codex";

/**
 * Incremental, stateful parser over an agent CLI's stdout stream. Both the
 * claude `stream-json` parser and the codex JSONL parser implement this so the
 * orchestrator consumes a single normalized shape (ADR: agent abstraction).
 */
export interface StreamParser {
  /** Feed a chunk of stdout; returns the events completed in this chunk. */
  push(chunk: string): ParsedEvent[];
  /** Flush any trailing line without a newline (process exit). */
  flush(): ParsedEvent[];
  readonly sessionId?: string;
  readonly model?: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /** Cost in USD reported by the stream, or 0 when the agent omits it. */
  readonly costUsd: number;
  /**
   * Invoked for every stdout line the parser could not decode. The line is
   * skipped, never thrown, so a malformed line can't crash the orchestrator
   * (issue #46). The orchestrator wires this to a structured log event.
   */
  onParseError?: (error: ParseError) => void;
}

export interface BuildArgsOptions {
  prompt: string;
  model: string;
  maxTurns: number;
}

export interface ResumeArgsOptions extends BuildArgsOptions {
  sessionId: string;
}

/**
 * A coding agent the orchestrator can spawn. The interface captures everything
 * agent-specific: how to invoke the CLI, how to parse its stream, and how to
 * price its token usage. The orchestrator itself stays agent-agnostic.
 */
export interface AgentProvider {
  readonly id: AgentId;
  /** Human-readable name for the UI. */
  readonly label: string;
  /** CLI binary name used when settings provide no explicit path. */
  readonly defaultCommand: string;
  /** Whether the CLI can resume a prior session (the CI-retry path). */
  readonly supportsResume: boolean;
  /** Model used on the cheaper/faster CI-fix resume path. */
  readonly resumeModel: string;
  /** Turn budget for the resume path. */
  readonly resumeMaxTurns: number;
  /** Model used when neither the job nor the repo specifies one. */
  readonly defaultModel: string;
  /** Build CLI args for a fresh session. */
  buildStartArgs(opts: BuildArgsOptions): string[];
  /** Build CLI args to resume a session, or null if the agent has no resume. */
  buildResumeArgs(opts: ResumeArgsOptions): string[] | null;
  /** Create a fresh incremental parser for this agent's stdout. */
  createParser(): StreamParser;
  /** Estimate cost in USD from token counts (used when the stream omits it). */
  estimateCost(model: string | null | undefined, inputTokens: number, outputTokens: number): number;
}
