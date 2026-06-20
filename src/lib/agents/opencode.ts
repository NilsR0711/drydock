import { z } from "zod";
import {
  type ContentChunk,
  errorMessage,
  type ParsedEvent,
  type ParseError,
} from "@/lib/stream/parser";
import type { AgentProvider, BuildArgsOptions, ResumeArgsOptions } from "./types";

/**
 * Default model for opencode (issue #349). opencode routes through models.dev
 * and supports 75+ providers behind one `provider/model` id, so there is no
 * single "right" default — this is just the fallback used when neither the job
 * nor the repo pins one. Users point a repo at whichever provider/model they
 * have configured credentials for in opencode (e.g. `openai/gpt-5`,
 * `openrouter/<model>`, `ollama/<model>`).
 */
export const OPENCODE_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

// opencode `run --format json` emits JSONL — one JSON object per line carrying a
// `type` field. The subset we consume (verified against the opencode stream-json
// schema): a `step_start` carrying the resumable `ses_…` session id, `text` and
// `tool_use` parts for each step, and a `step_finish` per API call carrying that
// step's `cost` and `tokens`. A multi-step turn (tool loop) emits one
// `step_finish` per call, so cost/tokens are summed across them, not replaced.
const tokensSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache: z
      .object({ read: z.number().optional(), write: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const partSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    // tool_use parts: the tool name, its call id, and a `state` carrying the input.
    callID: z.string().optional(),
    tool: z.string().optional(),
    state: z
      .object({ status: z.string().optional(), input: z.unknown().optional() })
      .passthrough()
      .optional(),
    // step-finish parts: per-step accounting.
    reason: z.string().optional(),
    cost: z.number().optional(),
    tokens: tokensSchema.optional(),
  })
  .passthrough();

const opencodeEvent = z
  .object({
    type: z.string(),
    sessionID: z.string().optional(),
    part: partSchema.optional(),
    // error events carry `{error:{name,data:{message}}}`.
    error: z
      .object({
        name: z.string().optional(),
        data: z.object({ message: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type OpencodeEvent = z.infer<typeof opencodeEvent>;
type OpencodePart = z.infer<typeof partSchema>;

/** The reason field on a terminal `step-finish` part (final answer, not a tool loop). */
const STOP_REASON = "stop";

function partChunks(part: OpencodePart): ContentChunk[] {
  if (part.type === "text") {
    return part.text ? [{ kind: "text", text: part.text }] : [];
  }
  // tool_use events arrive on tool completion with the call id, tool name, and
  // the input captured under `state`.
  if (part.tool) {
    return [
      {
        kind: "tool_use",
        name: part.tool,
        id: part.callID ?? "",
        input: part.state?.input,
      },
    ];
  }
  return [];
}

/** Normalize one parsed opencode event, or null for events we don't surface. */
function toParsed(event: OpencodeEvent): ParsedEvent | null {
  const base: ParsedEvent = {
    type: "assistant",
    chunks: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    isError: false,
    raw: event,
  };

  if (event.type === "step_start") {
    return { ...base, type: "system", sessionId: event.sessionID };
  }
  if (event.type === "text" || event.type === "tool_use") {
    const chunks = event.part ? partChunks(event.part) : [];
    return chunks.length > 0 ? { ...base, type: "assistant", chunks } : null;
  }
  if (event.type === "step_finish") {
    // Only the terminal step surfaces as a result; intermediate tool-loop steps
    // still accumulate usage (in consume) but are not published as events.
    return event.part?.reason === STOP_REASON ? { ...base, type: "result" } : null;
  }
  if (event.type === "error") {
    return { ...base, type: "result", isError: true };
  }
  return null;
}

/** Parse one opencode JSONL line into the raw event shape; null for blank lines. */
function parseOpencodeEventLine(line: string): OpencodeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const json = JSON.parse(trimmed);
  return opencodeEvent.parse(json);
}

/** Stateful, incremental JSONL parser for `opencode run --format json` stdout. */
export class OpencodeStreamParser {
  private buffer = "";
  sessionId?: string;
  model?: string;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheCreationInputTokens = 0;
  totalCacheReadInputTokens = 0;
  /** Sum of every step's reported USD cost — opencode prices each API call natively. */
  costUsd = 0;
  /** The final error message from an `error` event (issue #349). */
  resultText?: string;
  /** Whether the stream ended in an error event. */
  resultIsError = false;
  /** Invoked for every line that fails to parse; the line is then skipped. */
  onParseError?: (error: ParseError) => void;

  push(chunk: string): ParsedEvent[] {
    this.buffer += chunk;
    const events: ParsedEvent[] = [];
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const parsed = this.consume(line);
      if (parsed) events.push(parsed);
      nl = this.buffer.indexOf("\n");
    }
    return events;
  }

  flush(): ParsedEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = this.consume(rest);
    return parsed ? [parsed] : [];
  }

  private consume(line: string): ParsedEvent | null {
    let event: OpencodeEvent | null;
    try {
      event = parseOpencodeEventLine(line);
    } catch (error) {
      // opencode stdout is not guaranteed pure JSONL (banners, diagnostics).
      // Skip a bad line rather than letting it crash the orchestrator (issue #46).
      this.onParseError?.({ line: line.trim(), message: errorMessage(error) });
      return null;
    }
    if (!event) return null;
    if (event.sessionID) this.sessionId = event.sessionID;
    // Per-step accounting: every `step_finish` carries that API call's cost and
    // tokens, so a multi-step tool loop is summed across all of them (issue
    // #349). OpenAI-style reasoning tokens are billed as output, so fold them in.
    if (event.type === "step_finish" && event.part) {
      const t = event.part.tokens;
      this.totalInputTokens += t?.input ?? 0;
      this.totalOutputTokens += (t?.output ?? 0) + (t?.reasoning ?? 0);
      this.totalCacheCreationInputTokens += t?.cache?.write ?? 0;
      this.totalCacheReadInputTokens += t?.cache?.read ?? 0;
      this.costUsd += event.part.cost ?? 0;
    } else if (event.type === "error") {
      this.resultIsError = true;
      const message = event.error?.data?.message;
      if (message) this.resultText = message;
    }
    return toParsed(event);
  }
}

/**
 * opencode (SST's open-source terminal coding agent) as a third CLI agent
 * alongside claude/codex (issue #349). It is a spawned CLI with a non-interactive
 * `run` mode (`opencode run "<prompt>" --model provider/model --format json`),
 * so it maps onto the existing CLI-agent pattern: it streams JSONL that the
 * OpencodeStreamParser consumes, and the orchestrator's generic cost-cap guard
 * enforces a per-job budget from the parser's accumulated `costUsd`.
 *
 * Permissions: opencode starts from permissive defaults (edit and bash both
 * `allow`), which already covers headless work inside the worktree — no
 * acceptEdits-style flag is needed. `bypassPermissions` (the agent-driven
 * release path, issue #256) adds `--dangerously-skip-permissions` to also
 * auto-approve the few `ask` permissions (e.g. external_directory). The per-repo
 * command allowlist (issue #329) does not apply: opencode allows bash by default.
 *
 * Turn budget: `opencode run` has no `--max-turns` flag, so the turn budget is
 * intentionally not passed (like codex, issue #48); a runaway run is bounded by
 * the orchestrator's wall-clock timeout (issue #47).
 */
export const opencodeProvider: AgentProvider = {
  id: "opencode",
  label: "opencode",
  defaultCommand: "opencode",
  supportsResume: true,
  // Resume reuses the session's original model (see buildResumeArgs), so this
  // only feeds the (always-zero) cost estimate; opencode prices from the stream.
  resumeModel: OPENCODE_DEFAULT_MODEL,
  // opencode run has no turn-budget flag, so this is never sent as an arg.
  resumeMaxTurns: 15,
  defaultModel: OPENCODE_DEFAULT_MODEL,

  // `maxTurns` is intentionally not destructured: opencode run has no turn-budget
  // flag. The prompt is the trailing positional argument.
  buildStartArgs: ({ prompt, model, bypassPermissions }: BuildArgsOptions) => [
    "run",
    "--format",
    "json",
    "--model",
    model,
    ...(bypassPermissions ? ["--dangerously-skip-permissions"] : []),
    prompt,
  ],

  // Resume targets the recorded `ses_…` id and deliberately omits `--model`: the
  // session already carries its provider/model, and forcing a model here could
  // resume on a provider the user has not configured credentials for.
  buildResumeArgs: ({ prompt, sessionId, bypassPermissions }: ResumeArgsOptions) => [
    "run",
    "--format",
    "json",
    "--session",
    sessionId,
    ...(bypassPermissions ? ["--dangerously-skip-permissions"] : []),
    prompt,
  ],

  // One-shot text prompt (issue #49): no `--format json`, so opencode prints the
  // plain final message for the caller to parse a JSON array out of.
  buildOneShotArgs: ({ prompt, model }) => ["run", "--model", model, prompt],

  // Cost-tracked one-shot: same as the streaming start but without permission
  // bypass — a one-shot only reads, it never edits the repo.
  buildStreamOneShotArgs: ({ prompt, model }) => [
    "run",
    "--format",
    "json",
    "--model",
    model,
    prompt,
  ],

  createParser: () => new OpencodeStreamParser(),

  /**
   * Always 0: opencode reports exact per-step USD cost in the stream
   * (accumulated into the parser's `costUsd`). A static pricing table here would
   * drift from the live models.dev catalog across 75+ providers.
   */
  estimateCost(): number {
    return 0;
  },
};
