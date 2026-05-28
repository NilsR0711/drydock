import { z } from "zod";

// Claude Code `--output-format stream-json` event shapes (subset we consume).
const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

const systemEvent = z.object({
  type: z.literal("system"),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string().optional(),
});

const assistantEvent = z.object({
  type: z.literal("assistant"),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(z.record(z.string(), z.unknown())),
    usage: usageSchema.optional(),
  }),
});

const userEvent = z.object({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.array(z.record(z.string(), z.unknown())),
  }),
});

const resultEvent = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
  total_cost_usd: z.number().optional(),
  usage: usageSchema.optional(),
});

const streamEvent = z.discriminatedUnion("type", [
  systemEvent,
  assistantEvent,
  userEvent,
  resultEvent,
]);

export type StreamEvent = z.infer<typeof streamEvent>;

export interface TextChunk {
  kind: "text";
  text: string;
}
export interface ToolUseChunk {
  kind: "tool_use";
  name: string;
  id: string;
  input: unknown;
}
export interface ToolResultChunk {
  kind: "tool_result";
  toolUseId: string;
  isError: boolean;
}
export type ContentChunk = TextChunk | ToolUseChunk | ToolResultChunk;

export interface ParsedEvent {
  type: StreamEvent["type"];
  sessionId?: string;
  model?: string;
  chunks: ContentChunk[];
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  isError: boolean;
  /** The original event as emitted by the agent CLI (shape varies per agent). */
  raw: unknown;
}

/**
 * A line that could not be parsed (invalid JSON, or JSON that fails the event
 * schema). Surfaced via the parser's `onParseError` hook so a bad line becomes
 * an observable warning instead of an uncaught exception that crashes the
 * process (issue #46).
 */
export interface ParseError {
  /** The offending raw line (already trimmed of surrounding whitespace). */
  line: string;
  /** Human-readable reason the line was rejected. */
  message: string;
}

/** Best-effort message extraction from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse one NDJSON line. Returns null for blank lines; throws on malformed JSON. */
export function parseLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const json = JSON.parse(trimmed);
  const event = streamEvent.parse(json);
  return toParsed(event);
}

function toParsed(event: StreamEvent): ParsedEvent {
  const base: ParsedEvent = {
    type: event.type,
    chunks: [],
    inputTokens: 0,
    outputTokens: 0,
    isError: false,
    raw: event,
  };

  if (event.type === "system") {
    base.sessionId = event.session_id;
    base.model = event.model;
  } else if (event.type === "assistant") {
    base.chunks = extractContent(event.message.content);
    base.inputTokens = event.message.usage?.input_tokens ?? 0;
    base.outputTokens = event.message.usage?.output_tokens ?? 0;
  } else if (event.type === "user") {
    base.chunks = extractContent(event.message.content);
  } else {
    base.sessionId = event.session_id;
    base.costUsd = event.total_cost_usd;
    base.inputTokens = event.usage?.input_tokens ?? 0;
    base.outputTokens = event.usage?.output_tokens ?? 0;
    base.isError = event.is_error ?? false;
  }
  return base;
}

function extractContent(content: Array<Record<string, unknown>>): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      chunks.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use") {
      chunks.push({
        kind: "tool_use",
        name: String(block.name ?? "unknown"),
        id: String(block.id ?? ""),
        input: block.input,
      });
    } else if (block.type === "tool_result") {
      chunks.push({
        kind: "tool_result",
        toolUseId: String(block.tool_use_id ?? ""),
        isError: Boolean(block.is_error),
      });
    }
  }
  return chunks;
}

/** Stateful, incremental NDJSON parser that buffers partial lines from a stream. */
export class StreamJsonParser {
  private buffer = "";
  sessionId?: string;
  model?: string;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  costUsd = 0;
  /** Invoked for every line that fails to parse; the line is then skipped. */
  onParseError?: (error: ParseError) => void;

  /** Feed a chunk of stdout; returns the events completed in this chunk. */
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

  /** Flush any trailing line without a newline (process exit). */
  flush(): ParsedEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = this.consume(rest);
    return parsed ? [parsed] : [];
  }

  private consume(line: string): ParsedEvent | null {
    let parsed: ParsedEvent | null;
    try {
      parsed = parseLine(line);
    } catch (error) {
      // Agent CLIs do not guarantee pure NDJSON (banners, warnings, crash dumps).
      // A bad line must never escape as an uncaught exception — skip it and warn.
      this.onParseError?.({ line: line.trim(), message: errorMessage(error) });
      return null;
    }
    if (!parsed) return null;
    if (parsed.sessionId) this.sessionId = parsed.sessionId;
    if (parsed.model) this.model = parsed.model;
    this.totalInputTokens += parsed.inputTokens;
    this.totalOutputTokens += parsed.outputTokens;
    if (parsed.type === "result" && parsed.costUsd !== undefined) this.costUsd = parsed.costUsd;
    return parsed;
  }
}
