import type { ParsedEvent, ParseError, RawRateLimitInfo } from "@/lib/stream/parser";
import type { CodexUsageReading } from "./codex-usage";

/**
 * Coding agents Drydock can drive. claude/codex map to local CLIs; openrouter
 * talks to the hosted OpenRouter API over HTTP (issue #169, ADR 032).
 */
export type AgentId = "claude" | "codex" | "openrouter";

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
  /** Cache-write tokens accumulated from the stream; 0 for agents without cache reporting. */
  readonly totalCacheCreationInputTokens: number;
  /** Cache-read tokens accumulated from the stream; 0 for agents without cache reporting. */
  readonly totalCacheReadInputTokens: number;
  /** Cost in USD reported by the stream, or 0 when the agent omits it. */
  readonly costUsd: number;
  /** Final result text from the stream, when the agent emitted one (issue #166). */
  readonly resultText?: string;
  /**
   * Terminal result subtype, when the agent emits one (issue #277). The Claude
   * Code `stream-json` result carries e.g. `success` / `error_max_turns`; agents
   * without an analogous signal (codex) leave it undefined.
   */
  readonly resultSubtype?: string;
  /** Whether the stream's final result was flagged as an error (issue #166). */
  readonly resultIsError?: boolean;
  /**
   * Latest subscription rate-limit snapshot from the stream (issue #188), for
   * agents whose CLI emits one (claude). Absent for agents without it.
   */
  readonly rateLimit?: RawRateLimitInfo;
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
  /**
   * Run the session with full, unprompted shell access instead of the default
   * edits-only permission mode (issue #256). Only an agent-driven release sets
   * this: it must run the repo's release commands (gh/git/npm) itself, which the
   * default mode blocks headlessly. Off everywhere else, so no behaviour change.
   */
  bypassPermissions?: boolean;
}

export interface ResumeArgsOptions extends BuildArgsOptions {
  sessionId: string;
}

/**
 * A one-shot, non-streaming text prompt: the agent answers once and exits. Used
 * by issue decomposition (issue #49), which parses a JSON array out of the
 * plain final message rather than consuming the event stream.
 */
export interface OneShotArgsOptions {
  prompt: string;
  model: string;
}

/**
 * How a failed agent session maps to a provider-side condition (issue #166).
 * `usage_limit`, `rate_limit` and `overloaded` are transient — the orchestrator
 * can park the work and retry once the window resets. `auth` and `billing`
 * need an operator and must never auto-wait.
 */
export type ProviderLimitKind = "usage_limit" | "rate_limit" | "overloaded" | "auth" | "billing";

/** Kinds the orchestrator may park-and-retry instead of escalating to a human. */
export const WAITABLE_LIMIT_KINDS: readonly ProviderLimitKind[] = [
  "usage_limit",
  "rate_limit",
  "overloaded",
];

/** Normalized provider limit/auth failure, classified from CLI output. */
export interface ProviderLimitInfo {
  agent: AgentId;
  kind: ProviderLimitKind;
  /** Epoch seconds when the limit window resets, when the CLI reported one. */
  resetAt?: number;
  /** Suggested wait before retrying, when the CLI reported one. */
  retryAfterMs?: number;
  /** Short, secret-redacted excerpt of the triggering output for logs/events. */
  rawSnippet: string;
}

/** Everything a provider gets to classify a finished, failed session. */
export interface ClassifyFailureInput {
  exitCode: number;
  /** Tail of the session's stderr output. */
  stderr: string;
  /** Final result text from the stream, when the CLI emitted one. */
  resultText?: string;
  /** Whether the stream's result event was flagged as an error. */
  resultIsError?: boolean;
}

/**
 * A coding agent the orchestrator can spawn. The interface captures everything
 * agent-specific: how to invoke the CLI, how to parse its stream, and how to
 * price its token usage. The orchestrator itself stays agent-agnostic.
 */
export interface AgentProvider {
  readonly id: AgentId;
  /**
   * How the provider executes (issue #169): "cli" spawns a local binary and
   * parses its stdout; "http" talks to a hosted API — the CLI arg/parser
   * methods are unavailable and call sites must dispatch before using them.
   * Omitted means "cli".
   */
  readonly kind?: "cli" | "http";
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
  /**
   * Build CLI args for a one-shot text prompt that prints a plain answer and
   * exits (no streaming event format). Used by issue decomposition (issue #49).
   */
  buildOneShotArgs(opts: OneShotArgsOptions): string[];
  /**
   * Build CLI args for a cost-tracked one-shot in stream-json format, so the
   * runner can extract token usage and `total_cost_usd` from the result event.
   * Returns null when the provider does not support stream-json one-shots.
   */
  buildStreamOneShotArgs(opts: OneShotArgsOptions): string[] | null;
  /** Create a fresh incremental parser for this agent's stdout. */
  createParser(): StreamParser;
  /**
   * Classify a failed session as a provider limit/auth condition (issue #166),
   * or undefined when the failure carries no recognizable provider signal.
   * Optional: agents without limit detection simply fail generically.
   */
  classifyFailure?(input: ClassifyFailureInput): ProviderLimitInfo | undefined;
  /**
   * Pull the agent's proactively-reported quota snapshot from a finished
   * session's parser (issue #189), or undefined when the stream carried none.
   * Codex implements this from its structured `rate_limits` windows; Claude
   * instead exposes a qualitative reading via `parser.rateLimit` (issue #188).
   * Optional: agents that report no usage windows omit it.
   */
  captureUsage?(parser: StreamParser): CodexUsageReading | undefined;
  /**
   * Estimate cost in USD from token counts (used when the stream omits it).
   * Cache token counts are optional; providers without cache pricing (codex)
   * ignore them. Claude streams are cache-dominated, so omitting them would
   * undercount the live cost-cap guard and the persisted fallback cost.
   */
  estimateCost(
    model: string | null | undefined,
    inputTokens: number,
    outputTokens: number,
    cacheCreationTokens?: number,
    cacheReadTokens?: number,
  ): number;
}
