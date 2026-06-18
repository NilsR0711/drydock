import { beforeEach, describe, expect, it } from "vitest";
import { codexProvider } from "@/lib/agents/codex";
import type { AgentProvider } from "@/lib/agents/types";
import { createDb, type DB } from "@/lib/db/client";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import { spawnAgentSession } from "@/lib/orchestrator/agent-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker } from "@/lib/stream/broker";
import { StreamJsonParser } from "@/lib/stream/parser";

// A claude-shaped stream parser with deterministic token pricing so the running
// cost streamed on each event is predictable ($0.001 per output token).
const pricedProvider: AgentProvider = {
  ...codexProvider,
  createParser: () => new StreamJsonParser(),
  estimateCost: (_model, _input, output) => output * 0.001,
};

function assistantUsage(inputTokens: number, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  })}\n`;
}

function staticRunner(out: string): StreamRunner {
  return (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
    cb.onStdout(out);
    return { done: Promise.resolve(0), abort: () => {} };
  };
}

interface MetricsPayload {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r", agent: "codex" }, db).id;
});

describe("live job metrics stream (issue #242)", () => {
  it("publishes running token totals and live cost on each assistant event", async () => {
    const job = createJob({ repoId, issueNumber: 242, agent: "codex" }, db);
    const broker = new LogBroker(db);
    await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker,
      provider: pricedProvider,
      runner: staticRunner(assistantUsage(120_000, 3_400)),
    });

    const assistant = broker
      .replay(job.id)
      .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) as MetricsPayload }))
      .find((e) => e.type === "assistant");

    expect(assistant).toBeDefined();
    expect(assistant?.payload.inputTokens).toBe(120_000);
    expect(assistant?.payload.outputTokens).toBe(3_400);
    // 3_400 output tokens × $0.001 = $3.40 running estimate (no result event yet).
    expect(assistant?.payload.costUsd).toBeCloseTo(3.4, 5);
  });
});
