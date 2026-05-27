import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type DB, createDb } from "@/lib/db/client";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import { buildClaudeArgs, spawnClaudeSession } from "@/lib/orchestrator/claude-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker } from "@/lib/stream/broker";
import { beforeEach, describe, expect, it } from "vitest";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/stream-json/${name}`, import.meta.url)),
    "utf8",
  );
}

/** Fake stream runner: replays a fixture in two chunks, then exits. */
function fixtureRunner(ndjson: string, exitCode = 0): StreamRunner {
  return (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
    const mid = Math.floor(ndjson.length / 2);
    cb.onStdout(ndjson.slice(0, mid));
    cb.onStdout(ndjson.slice(mid));
    return { done: Promise.resolve(exitCode), abort: () => {} };
  };
}

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r", defaultModel: "claude-sonnet-4-5" }, db).id;
});

describe("buildClaudeArgs", () => {
  it("matches the SPEC invocation", () => {
    const args = buildClaudeArgs("do it", "claude-sonnet-4-5", 40);
    expect(args).toEqual([
      "-p",
      "do it",
      "--max-turns",
      "40",
      "--permission-mode",
      "acceptEdits",
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });
});

describe("spawnClaudeSession", () => {
  it("streams events, captures session id, and records cost from result event", async () => {
    const job = createJob({ repoId, issueNumber: 1, model: "claude-sonnet-4-5" }, db);
    const broker = new LogBroker(db);
    const res = await spawnClaudeSession(job, "fix the bug", "/tmp/r", {
      db,
      broker,
      runner: fixtureRunner(fixture("success.ndjson")),
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("sess-abc-123");
    expect(res.costUsd).toBeCloseTo(0.0421);

    const stored = getJob(job.id, db);
    expect(stored?.sessionId).toBe("sess-abc-123");
    expect(stored?.costUsd).toBeCloseTo(0.0421);
    expect(stored?.status).toBe("working");
    // events were published to the broker / persisted
    expect(broker.replay(job.id).length).toBeGreaterThan(20);
  });

  it("estimates cost from tokens when result has no total_cost_usd", async () => {
    const job = createJob({ repoId, issueNumber: 2, model: "claude-haiku-4-5" }, db);
    const ndjson = `${JSON.stringify({ type: "system", session_id: "s", model: "claude-haiku-4-5" })}\n${JSON.stringify(
      {
        type: "result",
        subtype: "success",
        session_id: "s",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    )}\n`;
    const res = await spawnClaudeSession(job, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      runner: fixtureRunner(ndjson),
    });
    // 1M input @ $1 (Haiku) = $1, no total_cost_usd in stream
    expect(res.costUsd).toBeCloseTo(1);
  });
});
