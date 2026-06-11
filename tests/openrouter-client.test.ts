import { describe, expect, it } from "vitest";
import {
  chatCompletion,
  checkOpenRouterKey,
  OPENROUTER_CHAT_URL,
  OpenRouterHttpError,
} from "@/lib/openrouter/client";

function sse(...events: string[]): string {
  return `${events.map((e) => `data: ${e}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

const TEXT_STREAM = [
  ": OPENROUTER PROCESSING",
  "",
  sse(
    '{"id":"gen-1","choices":[{"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
    '{"id":"gen-1","choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
    '{"id":"gen-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0001}}',
  ),
].join("\n");

const TOOL_STREAM = sse(
  '{"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":null}]}',
  '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":15,"cost":0.0002}}',
);

function fetchReturning(body: string, init: ResponseInit = { status: 200 }): typeof fetch {
  return async () => new Response(body, init);
}

describe("chatCompletion (issue #169)", () => {
  it("aggregates text deltas and maps usage accounting", async () => {
    const result = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning(TEXT_STREAM),
    });
    expect(result.text).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, costUsd: 0.0001 });
  });

  it("reassembles streamed tool calls across argument deltas", async () => {
    const result = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning(TOOL_STREAM),
    });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ]);
  });

  it("survives chunk boundaries that split an SSE line", async () => {
    const encoder = new TextEncoder();
    const half = Math.floor(TEXT_STREAM.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(TEXT_STREAM.slice(0, half)));
        controller.enqueue(encoder.encode(TEXT_STREAM.slice(half)));
        controller.close();
      },
    });
    const result = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    expect(result.text).toBe("Hello");
    expect(result.usage.costUsd).toBe(0.0001);
  });

  it("reports text deltas as they stream", async () => {
    const deltas: string[] = [];
    await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning(TEXT_STREAM),
      onTextDelta: (t) => deltas.push(t),
    });
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("sends auth, attribution headers and the streaming body shape", async () => {
    let url = "";
    let init: RequestInit | undefined;
    await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      siteUrl: "https://example.com",
      appName: "Drydock",
      fetchImpl: async (u, i) => {
        url = String(u);
        init = i;
        return new Response(TEXT_STREAM, { status: 200 });
      },
    });
    expect(url).toBe(OPENROUTER_CHAT_URL);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-v1-k");
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-Title"]).toBe("Drydock");
    const body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(true);
    expect(body.usage).toEqual({ include: true });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
      },
    ]);
  });

  it("serializes assistant tool calls and tool results on the wire", async () => {
    let body: Record<string, unknown> = {};
    await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }],
        },
        { role: "tool", content: "file body", toolCallId: "call_1" },
      ],
      fetchImpl: async (_u, i) => {
        body = JSON.parse(String(i?.body));
        return new Response(TEXT_STREAM, { status: 200 });
      },
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "file body",
    });
  });

  it("throws OpenRouterHttpError with retry-after on a 429", async () => {
    const err = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning('{"error":{"message":"Rate limit exceeded"}}', {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect(err.status).toBe(429);
    expect(err.body).toContain("Rate limit exceeded");
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("throws on a mid-stream error event", async () => {
    const stream = sse('{"error":{"code":502,"message":"Provider returned error"}}');
    const err = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning(stream),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect(err.status).toBe(502);
    expect(err.body).toContain("Provider returned error");
  });

  it("defaults usage to zero when the stream omits it", async () => {
    const stream = sse('{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}');
    const result = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning(stream),
    });
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });
});

describe("CodeRabbit findings on PR #187 (issue #169)", () => {
  it("checkOpenRouterKey arms an abort signal so a stalled probe cannot hang", async () => {
    let signal: AbortSignal | null | undefined;
    const probe: typeof fetch = async (_u, init) => {
      signal = init?.signal;
      return new Response("{}", { status: 200 });
    };
    const res = await checkOpenRouterKey("sk-or-v1-k", probe);
    expect(res).toEqual({ ok: true });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a stream that dies before any completion as a transport failure", async () => {
    const truncated = 'data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}\n\n';
    const err = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning(truncated),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect(err.status).toBe(502);
    expect(err.body).toMatch(/ended before completion/i);
  });

  it("accepts a finished stream whose [DONE] marker was lost in transit", async () => {
    const noDone =
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001}}\n\n';
    const result = await chatCompletion({
      apiKey: "sk-or-v1-k",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchReturning(noDone),
    });
    expect(result.text).toBe("ok");
    expect(result.finishReason).toBe("stop");
  });
});
