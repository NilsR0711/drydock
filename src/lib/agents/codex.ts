import { z } from "zod";
import type { ModelPrice } from "@/lib/orchestrator/pricing";
import type { ContentChunk, ParsedEvent } from "@/lib/stream/parser";
import type { AgentProvider } from "./types";

export const CODEX_DEFAULT_MODEL = "gpt-5-codex";

/**
 * Codex / OpenAI model pricing in USD per million tokens (2026-05; verify
 * against the current rate card). Codex does not report a USD cost in its
 * stream, so the orchestrator always estimates from these.
 */
export const CODEX_PRICING: Record<string, ModelPrice> = {
  "gpt-5-codex": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
};

const CODEX_DEFAULT_PRICE: ModelPrice = CODEX_PRICING[CODEX_DEFAULT_MODEL] as ModelPrice;

export function codexPriceForModel(model: string | null | undefined): ModelPrice {
  if (!model) return CODEX_DEFAULT_PRICE;
  return CODEX_PRICING[model] ?? CODEX_DEFAULT_PRICE;
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
    item: itemSchema.optional(),
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

/** Normalize one parsed codex event, or null for events we don't surface. */
function toParsed(event: CodexEvent): ParsedEvent | null {
  const base: ParsedEvent = {
    type: "assistant",
    chunks: [],
    inputTokens: 0,
    outputTokens: 0,
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

/** Parse one codex JSONL line. Returns null for blank lines; throws on bad JSON. */
export function parseCodexLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const json = JSON.parse(trimmed);
  return toParsed(codexEvent.parse(json));
}

/** Stateful, incremental JSONL parser for `codex exec --json` stdout. */
export class CodexStreamParser {
  private buffer = "";
  sessionId?: string;
  model?: string;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  /** Codex omits USD cost from its stream; always 0 (cost is estimated). */
  costUsd = 0;

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
    const parsed = parseCodexLine(line);
    if (!parsed) return null;
    if (parsed.sessionId) this.sessionId = parsed.sessionId;
    this.totalInputTokens += parsed.inputTokens;
    this.totalOutputTokens += parsed.outputTokens;
    return parsed;
  }
}

/**
 * The Codex CLI as an AgentProvider. Invocation: `codex exec --json` for a fresh
 * run and `codex exec resume <thread_id> --json` for the CI-fix path. The
 * `workspace-write` sandbox maps to claude's `--permission-mode acceptEdits`
 * (auto-apply edits within the worktree, no network/system writes).
 */
export const codexProvider: AgentProvider = {
  id: "codex",
  label: "Codex CLI",
  defaultCommand: "codex",
  supportsResume: true,
  resumeModel: CODEX_DEFAULT_MODEL,
  resumeMaxTurns: 15,
  defaultModel: CODEX_DEFAULT_MODEL,

  buildStartArgs: ({ prompt, model }) => [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--model",
    model,
    prompt,
  ],

  buildResumeArgs: ({ prompt, sessionId, model }) => [
    "exec",
    "resume",
    sessionId,
    "--json",
    "--sandbox",
    "workspace-write",
    "--model",
    model,
    prompt,
  ],

  createParser: () => new CodexStreamParser(),

  estimateCost: estimateCodexCost,
};
