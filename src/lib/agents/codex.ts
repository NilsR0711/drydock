import { z } from "zod";
import type { ModelPrice } from "@/lib/orchestrator/pricing";
import {
  type ContentChunk,
  errorMessage,
  type ParsedEvent,
  type ParseError,
} from "@/lib/stream/parser";
import { classifyCodexFailure } from "./codex-limits";
import type { CodexUsageReading, CodexUsageWindowReading } from "./codex-usage";
import type { AgentProvider } from "./types";

export const CODEX_DEFAULT_MODEL = "gpt-5-codex";

/**
 * Codex / OpenAI model pricing in USD per million tokens (2026-05; verify
 * against the current rate card). Codex does not report a USD cost in its
 * stream, so the orchestrator always estimates from these.
 */
export const CODEX_PRICING: Record<string, ModelPrice> = {
  "gpt-5-codex": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0,
  },
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
};

/** The most expensive entry in CODEX_PRICING by output rate — used as a fail-safe fallback. */
export const CODEX_MAX_PRICE: ModelPrice = Object.values(CODEX_PRICING).reduce(
  (max, p) => (p.outputPerMTok > max.outputPerMTok ? p : max),
  { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
);

export function codexPriceForModel(model: string | null | undefined): ModelPrice {
  if (!model) return CODEX_MAX_PRICE;
  const known = CODEX_PRICING[model];
  if (known) return known;
  console.warn(
    `[drydock] Unknown codex model id "${model}" — using max-priced fallback to avoid under-counting cost`,
  );
  return CODEX_MAX_PRICE;
}

function estimateCodexCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = codexPriceForModel(model);
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}

// Codex CLI `codex exec --json` event shapes (the subset we consume). The CLI
// streams one JSON object per line: a thread.started carrying the resumable
// thread id, item.* events for each step, and a turn.completed carrying usage.
const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    reasoning_output_tokens: z.number().optional(),
  })
  .passthrough();

// Codex reports its OAuth quota proactively on a `token_count` event (issue
// #189): `rate_limits.{primary,secondary}` each carry `used_percent`,
// `window_minutes`, and `resets_in_seconds`. Field names verified against the
// Codex CLI JSONL schema (openai/codex #14728). In `exec` mode older builds
// send `rate_limits: null` (no `x-codex-*` headers), so every level is nullish.
const rateLimitWindowSchema = z
  .object({
    used_percent: z.number().optional(),
    window_minutes: z.number().optional(),
    resets_in_seconds: z.number().optional(),
  })
  .passthrough();

const rateLimitsSchema = z
  .object({
    primary: rateLimitWindowSchema.nullish(),
    secondary: rateLimitWindowSchema.nullish(),
  })
  .passthrough();

const itemSchema = z
  .object({
    id: z.string().optional(),
    item_type: z.string().optional(),
    text: z.string().optional(),
    command: z.string().optional(),
    exit_code: z.number().optional(),
    server: z.string().optional(),
    tool: z.string().optional(),
  })
  .passthrough();

const codexEvent = z
  .object({
    type: z.string(),
    thread_id: z.string().optional(),
    usage: usageSchema.optional(),
    rate_limits: rateLimitsSchema.nullish(),
    item: itemSchema.optional(),
    // turn.failed carries `{error:{message}}`; fatal stream `error` events
    // carry a top-level `message` (issue #167). Neither has structured codes.
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
    message: z.string().optional(),
  })
  .passthrough();

type CodexEvent = z.infer<typeof codexEvent>;
type CodexItem = z.infer<typeof itemSchema>;

function itemChunks(item: CodexItem): ContentChunk[] {
  const id = item.id ?? "";
  switch (item.item_type) {
    case "assistant_message":
    case "reasoning":
      return item.text ? [{ kind: "text", text: item.text }] : [];
    case "command_execution":
      return [
        {
          kind: "tool_use",
          name: "command",
          id,
          input: { command: item.command, exit_code: item.exit_code },
        },
      ];
    case "file_change":
      return [{ kind: "tool_use", name: "edit", id, input: item }];
    case "mcp_tool_call":
      return [
        {
          kind: "tool_use",
          name: `${item.server ?? "mcp"}/${item.tool ?? "tool"}`,
          id,
          input: item,
        },
      ];
    default:
      return [];
  }
}

type CodexRateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

/** One window's numbers, or undefined when it carried no `used_percent`. */
function windowReading(
  window: CodexRateLimitWindow | null | undefined,
): CodexUsageWindowReading | undefined {
  if (!window || typeof window.used_percent !== "number") return undefined;
  return {
    usedPercent: window.used_percent,
    windowMinutes: window.window_minutes,
    resetsInSeconds: window.resets_in_seconds,
  };
}

/**
 * Pull a usable quota snapshot out of a parsed codex event (issue #189), or
 * undefined when the event carried no rate-limit data — a null `rate_limits`
 * (exec mode), the field absent (older CLI), or no window with a percent. The
 * input is loosely typed so the same extractor serves the parser and tests.
 */
export function codexRateLimitReading(event: {
  rate_limits?: unknown;
  [key: string]: unknown;
}): CodexUsageReading | undefined {
  const limits = rateLimitsSchema.nullish().safeParse(event.rate_limits);
  if (!limits.success || !limits.data) return undefined;
  const primary = windowReading(limits.data.primary);
  const secondary = windowReading(limits.data.secondary);
  if (!primary && !secondary) return undefined;
  return { primary, secondary };
}

/** Normalize one parsed codex event, or null for events we don't surface. */
function toParsed(event: CodexEvent): ParsedEvent | null {
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

  if (event.type === "thread.started") {
    return { ...base, type: "system", sessionId: event.thread_id };
  }
  if (event.type === "item.completed" && event.item) {
    return { ...base, type: "assistant", chunks: itemChunks(event.item) };
  }
  if (event.type === "turn.completed") {
    const u = event.usage;
    return {
      ...base,
      type: "result",
      inputTokens: u?.input_tokens ?? 0,
      // OpenAI bills reasoning tokens as output, so fold them in.
      outputTokens: (u?.output_tokens ?? 0) + (u?.reasoning_output_tokens ?? 0),
    };
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return { ...base, type: "result", isError: true };
  }
  // turn.started, item.started, item.updated, thread.* progress — not surfaced.
  return null;
}

/** Parse one codex JSONL line into the raw event shape; null for blank lines. */
function parseCodexEventLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const json = JSON.parse(trimmed);
  return codexEvent.parse(json);
}

/** Parse one codex JSONL line. Returns null for blank lines; throws on bad JSON. */
export function parseCodexLine(line: string): ParsedEvent | null {
  const event = parseCodexEventLine(line);
  return event ? toParsed(event) : null;
}

/** Stateful, incremental JSONL parser for `codex exec --json` stdout. */
export class CodexStreamParser {
  private buffer = "";
  sessionId?: string;
  model?: string;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  /**
   * Codex reports `cached_input_tokens` as part of `input_tokens` and its
   * pricing table carries no cache rates, so cache totals stay 0 — they exist
   * to satisfy the StreamParser contract used for claude cache pricing.
   */
  totalCacheCreationInputTokens = 0;
  totalCacheReadInputTokens = 0;
  /** Codex omits USD cost from its stream; always 0 (cost is estimated). */
  costUsd = 0;
  /**
   * The final failure message from `turn.failed` / a fatal stream `error`
   * event (issue #167). The CLI also emits non-fatal `error` events (e.g.
   * "Reconnecting... 1/5"); a later `turn.completed` clears both fields so a
   * recovered session never looks failed.
   */
  resultText?: string;
  /** Whether the stream ended in a failed turn / fatal error (issue #167). */
  resultIsError?: boolean;
  /**
   * Latest OAuth quota snapshot seen in the stream (issue #189), or undefined
   * when the CLI reported none. A fresh non-empty reading replaces the prior
   * one so the captured value reflects the most recent window state.
   */
  rateLimits?: CodexUsageReading;
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
    let event: CodexEvent | null;
    try {
      event = parseCodexEventLine(line);
    } catch (error) {
      // Codex stdout is not guaranteed pure JSONL (banners, MCP diagnostics,
      // crash dumps). Skip a bad line rather than letting it crash the process.
      this.onParseError?.({ line: line.trim(), message: errorMessage(error) });
      return null;
    }
    if (!event) return null;
    // Proactive quota capture (issue #189): a `token_count` event carries the
    // OAuth rate-limit windows; keep the latest usable reading regardless of
    // which event surfaced it, so success and failure paths both report it.
    const reading = codexRateLimitReading(event);
    if (reading) this.rateLimits = reading;
    // Failure-text tracking for the limit classifier (issue #167): keep the
    // last error message seen; a completed turn wins over earlier transient
    // errors (the CLI's reconnect notices arrive as `error` events too).
    if (event.type === "turn.failed" || event.type === "error") {
      this.resultIsError = true;
      const message = event.error?.message ?? event.message;
      if (message) this.resultText = message;
    } else if (event.type === "turn.completed") {
      this.resultIsError = false;
      this.resultText = undefined;
    }
    const parsed = toParsed(event);
    if (!parsed) return null;
    if (parsed.sessionId) this.sessionId = parsed.sessionId;
    this.totalInputTokens += parsed.inputTokens;
    this.totalOutputTokens += parsed.outputTokens;
    return parsed;
  }
}

/**
 * Codex's sandbox/approval flags for an `exec` run. The default maps to Claude's
 * edits-only `--permission-mode acceptEdits`: `--sandbox workspace-write`
 * auto-applies edits inside the worktree but blocks network and out-of-tree
 * writes. `bypassPermissions` (issue #256, agent-driven release) instead grants
 * full, unsandboxed access via `--dangerously-bypass-approvals-and-sandbox` —
 * the codex analogue of Claude's `--dangerously-skip-permissions` — so the run
 * can execute the repo's release commands (gh/git/npm), which the sandbox blocks
 * headlessly. The bypass flag disables the sandbox outright, so it replaces the
 * `--sandbox` flag rather than layering on top of it. Codex has no per-command
 * allowlist analogous to Claude's `--allowedTools`, so `allowedCommands` is
 * intentionally not honoured here.
 */
function codexSandboxArgs(bypassPermissions: boolean | undefined): string[] {
  return bypassPermissions
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--sandbox", "workspace-write"];
}

/**
 * The Codex CLI as an AgentProvider. Invocation: `codex exec --json` for a fresh
 * run and `codex exec resume <thread_id> --json` for the CI-fix path. The
 * `workspace-write` sandbox maps to claude's `--permission-mode acceptEdits`
 * (auto-apply edits within the worktree, no network/system writes); a release
 * run bypasses both sandbox and approvals (see `codexSandboxArgs`).
 *
 * Turn budget (issue #48): unlike Claude (`--max-turns`), `codex exec` has no
 * turn-budget flag or config key. It runs a *single* turn (TurnStart →
 * TurnCompleted) that may contain many tool-call items, so there is no per-turn
 * count to cap, and injecting a fake flag would be ignored — or rejected under
 * `--strict-config`. The `maxTurns` / `resumeMaxTurns` budget is therefore
 * intentionally not passed to the codex args; a runaway run is bounded by the
 * orchestrator's wall-clock timeout (issue #47) instead. Verified against the
 * codex-rs `exec` CLI and config schema (no `max_turns`/`max_steps` key exists).
 */
export const codexProvider: AgentProvider = {
  id: "codex",
  label: "Codex CLI",
  defaultCommand: "codex",
  supportsResume: true,
  resumeModel: CODEX_DEFAULT_MODEL,
  // Satisfies the AgentProvider contract but is intentionally unused: codex exec
  // has no turn budget (see the note above). Cost is bounded by the wall-clock
  // timeout, not by turns.
  resumeMaxTurns: 15,
  defaultModel: CODEX_DEFAULT_MODEL,

  // `maxTurns` is intentionally not destructured: codex exec has no turn-budget
  // flag (issue #48). See the provider doc comment above. `bypassPermissions`
  // selects the sandbox flag (issue #256); see `codexSandboxArgs`.
  buildStartArgs: ({ prompt, model, bypassPermissions }) => [
    "exec",
    "--json",
    ...codexSandboxArgs(bypassPermissions),
    "--model",
    model,
    prompt,
  ],

  // `maxTurns` intentionally unused on resume too (no codex turn-budget flag, #48).
  // Symmetric with buildStartArgs: a resumed release session keeps full access.
  buildResumeArgs: ({ prompt, sessionId, model, bypassPermissions }) => [
    "exec",
    "resume",
    sessionId,
    "--json",
    ...codexSandboxArgs(bypassPermissions),
    "--model",
    model,
    prompt,
  ],

  // One-shot text prompt (issue #49): `codex exec` without `--json` prints the
  // plain final message, which the caller parses for a JSON array. No sandbox
  // flag — decomposition only reads the issue prose, it never edits the repo.
  buildOneShotArgs: ({ prompt, model }) => ["exec", "--model", model, prompt],

  // Codex CLI does not support --output-format stream-json; cost tracking for
  // Codex one-shots is not available.
  buildStreamOneShotArgs: () => null,

  createParser: () => new CodexStreamParser(),

  classifyFailure: classifyCodexFailure,

  // Surface the quota snapshot captured during the run (issue #189). Only the
  // codex parser tracks rate limits, so a foreign parser yields nothing.
  captureUsage: (parser) => (parser instanceof CodexStreamParser ? parser.rateLimits : undefined),

  estimateCost: estimateCodexCost,
};
