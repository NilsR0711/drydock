import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { openrouterModels } from "@/lib/db/schema";
import { runOpenRouterJobSession } from "@/lib/openrouter/session";
import type { ToolExecResult } from "@/lib/openrouter/tools";
import { resumeAgentSession, spawnAgentSession } from "@/lib/orchestrator/agent-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { latchProviderLimit } from "@/lib/orchestrator/provider-limit";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";
import { LogBroker } from "@/lib/stream/broker";

const MODEL = "meta-llama/llama-3.3-70b-instruct:free";

function sse(...events: string[]): string {
  return `${events.map((e) => `data: ${e}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function toolCallStream(name: string, args: Record<string, unknown>, cost = 0.001): string {
  return sse(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost },
    }),
  );
}

function doneStream(text: string, cost = 0.002): string {
  return sse(
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 40, cost },
    }),
  );
}

interface SeqFetch {
  fetch: typeof fetch;
  bodies: () => Array<Record<string, unknown>>;
}

/** A fetch that replays the given SSE bodies in order and records requests. */
function sequenceFetch(streams: string[]): SeqFetch {
  const recorded: Array<Record<string, unknown>> = [];
  let i = 0;
  const f: typeof fetch = async (_url, init) => {
    recorded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const body = streams[Math.min(i, streams.length - 1)];
    i += 1;
    return new Response(body, { status: 200 });
  };
  return { fetch: f, bodies: () => recorded };
}

const okExecutor = (result = "ok"): ((...args: unknown[]) => Promise<ToolExecResult>) =>
  vi.fn(async () => ({ content: result, isError: false }));

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  db.insert(openrouterModels)
    .values({
      id: MODEL,
      name: "Llama 3.3 70B (free)",
      supportedParameters: '["tools"]',
      supportsTools: true,
      isFree: true,
      promptCostPerToken: 0,
      completionCostPerToken: 0,
      syncedAt: 1,
    })
    .run();
  saveSettings({ openrouterEnabled: true, openrouterApiKey: "sk-or-v1-k" }, db);
  repoId = addRepo({ path: "/tmp/r", name: "r", agent: "openrouter", defaultModel: MODEL }, db).id;
});

function makeJob(model?: string) {
  const job = createJob({ repoId, issueNumber: 1, agent: "openrouter", model }, db);
  return getJob(job.id, db) as NonNullable<ReturnType<typeof getJob>>;
}

describe("runOpenRouterJobSession (issue #169)", () => {
  it("drives a tool loop to completion and persists usage on the job", async () => {
    const seq = sequenceFetch([
      toolCallStream("write_file", { path: "a.txt", content: "hi" }),
      doneStream("All done."),
    ]);
    const executor = okExecutor();
    const job = makeJob();
    const res = await runOpenRouterJobSession(job, "implement it", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      fetchImpl: seq.fetch,
      toolExecutor: executor as never,
    });

    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.costExceeded).toBe(false);
    expect(res.costUsd).toBeCloseTo(0.003, 9);
    expect(res.inputTokens).toBe(300);
    expect(res.outputTokens).toBe(60);

    // The tool was executed with the streamed arguments in the worktree.
    expect(executor).toHaveBeenCalledTimes(1);
    const [call, cwd] = (executor as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { name: string; arguments: string },
      string,
    ];
    expect(call.name).toBe("write_file");
    expect(cwd).toBe("/tmp/wt");

    // Conversation wiring: system prompt first, tool result fed back.
    const first = seq.bodies()[0] as { messages: Array<{ role: string; content: string }> };
    expect(first.messages[0]?.role).toBe("system");
    expect(first.messages[0]?.content).toMatch(/do not commit/i);
    const second = seq.bodies()[1] as { messages: Array<{ role: string }> };
    expect(second.messages.some((m) => m.role === "tool")).toBe(true);

    // Usage lands on the job row (replacing, like a main CLI session).
    const after = getJob(job.id, db);
    expect(after?.status).toBe("working");
    expect(after?.costUsd).toBeCloseTo(0.003, 9);
    expect(after?.totalInputTokens).toBe(300);
    expect(after?.totalOutputTokens).toBe(60);
    expect(after?.model).toBe(MODEL);
  });

  it("resolves the model from the repo when the job has none", async () => {
    const seq = sequenceFetch([doneStream("done")]);
    const job = makeJob();
    const res = await runOpenRouterJobSession(job, "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      fetchImpl: seq.fetch,
    });
    expect(res.exitCode).toBe(0);
    expect((seq.bodies()[0] as { model: string }).model).toBe(MODEL);
  });

  it("refuses to start when the backend is disabled", async () => {
    saveSettings({ openrouterEnabled: false }, db);
    const fetchSpy = vi.fn();
    const res = await runOpenRouterJobSession(makeJob(), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      fetchImpl: fetchSpy as never,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.spawnError?.message).toMatch(/disabled/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses models without tool support for implementation sessions", async () => {
    db.insert(openrouterModels)
      .values({
        id: "chat/only",
        name: "Chat Only",
        supportedParameters: "[]",
        supportsTools: false,
        isFree: true,
        syncedAt: 1,
      })
      .run();
    const res = await runOpenRouterJobSession(makeJob("chat/only"), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.spawnError?.message).toMatch(/tool/i);
  });

  it("refuses models missing from the catalog with an actionable error", async () => {
    const res = await runOpenRouterJobSession(makeJob("gone/model"), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.spawnError?.message).toMatch(/catalog/i);
  });

  it("is refused by an active provider-limit latch without spending a request", async () => {
    latchProviderLimit(
      { agent: "openrouter", kind: "rate_limit", rawSnippet: "HTTP 429" },
      db,
      Math.floor(Date.now() / 1000),
    );
    const fetchSpy = vi.fn();
    const res = await runOpenRouterJobSession(makeJob(), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      fetchImpl: fetchSpy as never,
    });
    expect(res.exitCode).toBe(-3);
    expect(res.limit?.latched).toBe(true);
    expect(res.limit?.kind).toBe("rate_limit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies a 429 mid-session as a provider limit", async () => {
    const res = await runOpenRouterJobSession(makeJob(), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      fetchImpl: async () =>
        new Response("Rate limit exceeded", { status: 429, headers: { "Retry-After": "30" } }),
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.limit?.kind).toBe("rate_limit");
    expect(res.limit?.retryAfterMs).toBe(30_000);
  });

  it("aborts on the per-job cost cap", async () => {
    const seq = sequenceFetch([
      toolCallStream("run_command", { command: "true" }, 0.6),
      toolCallStream("run_command", { command: "true" }, 0.6),
      doneStream("never reached"),
    ]);
    const res = await runOpenRouterJobSession(makeJob(), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      costCapUsd: 1,
      fetchImpl: seq.fetch,
      toolExecutor: okExecutor() as never,
    });
    expect(res.costExceeded).toBe(true);
    expect(res.exitCode).toBe(-2);
    expect(res.costUsd).toBeCloseTo(1.2, 9);
    expect(seq.bodies()).toHaveLength(2);
  });

  it("times out on the wall clock", async () => {
    const res = await runOpenRouterJobSession(makeJob(), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      timeoutMs: 40,
      fetchImpl: (async (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as never,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(-1);
  });

  it("stops after the turn budget instead of looping forever", async () => {
    const seq = sequenceFetch([toolCallStream("run_command", { command: "true" })]);
    const job = makeJob();
    const res = await runOpenRouterJobSession(job, "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      maxTurns: 3,
      fetchImpl: seq.fetch,
      toolExecutor: okExecutor() as never,
    });
    expect(res.exitCode).not.toBe(0);
    expect(seq.bodies()).toHaveLength(3);
  });
});

describe("agent-session dispatch for http providers (issue #169)", () => {
  it("spawnAgentSession routes openrouter jobs to the HTTP session", async () => {
    const seq = sequenceFetch([doneStream("done", 0.004)]);
    const job = makeJob();
    const res = await spawnAgentSession(job, "do it", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      fetchImpl: seq.fetch,
      runner: (() => {
        throw new Error("CLI runner must not be called for http providers");
      }) as never,
    });
    expect(res.exitCode).toBe(0);
    expect(res.costUsd).toBeCloseTo(0.004, 9);
    expect(getJob(job.id, db)?.costUsd).toBeCloseTo(0.004, 9);
  });

  it("resumeAgentSession runs a fresh HTTP session and accumulates cost additively", async () => {
    const seq = sequenceFetch([doneStream("fixed", 0.01)]);
    const job = makeJob();
    db.update((await import("@/lib/db/schema")).jobs)
      .set({ costUsd: 0.05, totalInputTokens: 10, totalOutputTokens: 5, status: "working" })
      .run();
    const res = await resumeAgentSession(job, "no-session", "ci log", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      fetchImpl: seq.fetch,
      resumePrompt: "continue the work",
      runner: (() => {
        throw new Error("CLI runner must not be called for http providers");
      }) as never,
    });
    expect(res.exitCode).toBe(0);
    const after = getJob(job.id, db);
    expect(after?.costUsd).toBeCloseTo(0.06, 9);
    expect(after?.totalInputTokens).toBe(210);
    expect(after?.totalOutputTokens).toBe(45);
  });
});

describe("CodeRabbit findings on PR #187 (issue #169)", () => {
  it("enforces the session deadline through tool execution", async () => {
    const seq = sequenceFetch([toolCallStream("run_command", { command: "sleep" })]);
    const executor = vi.fn(
      (_call: unknown, _cwd: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise<ToolExecResult>((resolve) => {
          // A "hung" tool that only returns when the session aborts it.
          opts?.signal?.addEventListener("abort", () =>
            resolve({ content: "aborted", isError: true }),
          );
        }),
    );
    const res = await runOpenRouterJobSession(makeJob(), "p", "/tmp/wt", {
      db,
      broker: new LogBroker(db),
      timeoutMs: 80,
      fetchImpl: seq.fetch,
      toolExecutor: executor as never,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(-1);
    // The executor received the abort signal and the remaining budget.
    const opts = (executor.mock.calls[0] as unknown[])[2] as {
      signal?: AbortSignal;
      timeoutMs?: number;
    };
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts?.timeoutMs).toBeLessThanOrEqual(80);
  });
});
