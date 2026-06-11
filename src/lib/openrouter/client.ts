import { z } from "zod";

/**
 * Minimal OpenRouter chat-completions client (issue #169). Streams SSE so long
 * generations survive proxy idle timeouts, aggregates the deltas into a single
 * completed message (text + tool calls), and returns OpenRouter's own usage
 * accounting (`usage.cost` is USD) as the authoritative cost source.
 */

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/**
 * Probe whether an API key is accepted (settings "Test connection" button):
 * a cheap authenticated GET against the key endpoint, no tokens spent.
 */
export async function checkOpenRouterKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { ok: true };
    const body = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: `OpenRouter HTTP ${res.status}: ${body}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Non-2xx response or a mid-stream error event from OpenRouter. */
export class OpenRouterHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`OpenRouter HTTP ${status}: ${body}`);
    this.name = "OpenRouterHttpError";
  }
}

export interface OpenRouterToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string, exactly as the model produced it. */
  arguments: string;
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool calls made by an assistant message. */
  toolCalls?: OpenRouterToolCall[];
  /** The call a `tool` role message answers. */
  toolCallId?: string;
}

export interface OpenRouterToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface OpenRouterUsage {
  promptTokens: number;
  completionTokens: number;
  /** USD as reported by OpenRouter's usage accounting; 0 when omitted. */
  costUsd: number;
}

export interface OpenRouterCompletion {
  text: string;
  toolCalls: OpenRouterToolCall[];
  finishReason: string | null;
  usage: OpenRouterUsage;
}

const deltaToolCallSchema = z.object({
  index: z.number(),
  id: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z.array(deltaToolCallSchema).optional(),
          })
          .passthrough()
          .optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().nullish(),
    })
    .passthrough()
    .nullish(),
  error: z
    .object({
      code: z.union([z.number(), z.string()]).nullish(),
      message: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

function toWireMessage(m: OpenRouterMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: m.role, content: m.content };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const ms = at - Date.now();
  return ms > 0 ? ms : undefined;
}

/** Yield decoded lines from an SSE body, buffering across chunk boundaries. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        yield buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}

interface ToolCallDraft {
  id: string;
  name: string;
  argumentParts: string[];
}

/**
 * Run one streaming chat completion and aggregate it into a completed message.
 * Throws {@link OpenRouterHttpError} on non-2xx responses and on mid-stream
 * error events; malformed SSE data lines are skipped, never fatal.
 */
export async function chatCompletion(opts: {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterToolDef[];
  maxTokens?: number;
  /** Optional attribution headers (OpenRouter app rankings). */
  siteUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Streamed text deltas, e.g. for live job-log events. */
  onTextDelta?: (text: string) => void;
}): Promise<OpenRouterCompletion> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
  };
  if (opts.siteUrl) headers["HTTP-Referer"] = opts.siteUrl;
  if (opts.appName) headers["X-Title"] = opts.appName;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map(toWireMessage),
    stream: true,
    // OpenRouter usage accounting: the final SSE chunk carries token counts
    // and the exact USD cost of the generation.
    usage: { include: true },
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const res = await fetchImpl(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = (await res.text().catch(() => "")).slice(0, 2000);
    throw new OpenRouterHttpError(
      res.status,
      errBody,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  if (!res.body) throw new OpenRouterHttpError(res.status, "response had no body");

  let text = "";
  let finishReason: string | null = null;
  const usage: OpenRouterUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  const drafts = new Map<number, ToolCallDraft>();

  for await (const line of sseLines(res.body)) {
    if (!line || line.startsWith(":")) continue; // keep-alive comments
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    let parsed: z.infer<typeof chunkSchema>;
    try {
      parsed = chunkSchema.parse(JSON.parse(data));
    } catch {
      continue; // one malformed chunk must not kill the session
    }
    if (parsed.error) {
      const code = typeof parsed.error.code === "number" ? parsed.error.code : 500;
      throw new OpenRouterHttpError(code, parsed.error.message ?? "stream error");
    }
    const choice = parsed.choices?.[0];
    if (choice?.delta?.content) {
      text += choice.delta.content;
      opts.onTextDelta?.(choice.delta.content);
    }
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const draft = drafts.get(tc.index) ?? { id: "", name: "", argumentParts: [] };
      if (tc.id) draft.id = tc.id;
      if (tc.function?.name) draft.name = tc.function.name;
      if (tc.function?.arguments) draft.argumentParts.push(tc.function.arguments);
      drafts.set(tc.index, draft);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (parsed.usage) {
      usage.promptTokens = parsed.usage.prompt_tokens ?? usage.promptTokens;
      usage.completionTokens = parsed.usage.completion_tokens ?? usage.completionTokens;
      usage.costUsd = parsed.usage.cost ?? usage.costUsd;
    }
  }

  const toolCalls: OpenRouterToolCall[] = [...drafts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, d]) => ({ id: d.id, name: d.name, arguments: d.argumentParts.join("") }));

  return { text, toolCalls, finishReason, usage };
}
