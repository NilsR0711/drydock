import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { codexProvider } from "@/lib/agents/codex";
import type { AgentProvider } from "@/lib/agents/types";
import { createDb, type DB } from "@/lib/db/client";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import { resumeAgentSession, spawnAgentSession } from "@/lib/orchestrator/agent-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker } from "@/lib/stream/broker";

function codexFixture(): string {
  return readFileSync(
    fileURLToPath(new URL("./fixtures/codex/success.jsonl", import.meta.url)),
    "utf8",
  );
}

interface Captured {
  cmd?: string;
  args?: string[];
}

function captureRunner(out: string, captured: Captured, exitCode = 0): StreamRunner {
  return (cmd, args, _cwd, cb: StreamCallbacks): StreamHandle => {
    captured.cmd = cmd;
    captured.args = args;
    cb.onStdout(out);
    return { done: Promise.resolve(exitCode), abort: () => {} };
  };
}

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r", agent: "codex" }, db).id;
});

describe("spawnAgentSession", () => {
  it("drives the codex CLI and prices its run from the codex table", async () => {
    const job = createJob({ repoId, issueNumber: 1, agent: "codex", model: "gpt-5-codex" }, db);
    const captured: Captured = {};
    const res = await spawnAgentSession(getJob(job.id, db) as never, "fix it", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      runner: captureRunner(codexFixture(), captured),
    });

    expect(captured.cmd).toBe("codex");
    expect(captured.args?.[0]).toBe("exec");
    expect(res.sessionId).toBe("th_codex_abc");
    // 12000 input @ $1.25/MTok + 2000 output @ $10/MTok = 0.015 + 0.02
    expect(res.costUsd).toBeCloseTo(0.035, 5);
    expect(getJob(job.id, db)?.sessionId).toBe("th_codex_abc");
  });

  it("emits a parse_error event for a malformed stdout line instead of crashing (issue #46)", async () => {
    const job = createJob({ repoId, issueNumber: 4, agent: "codex" }, db);
    const broker = new LogBroker(db);
    const captured: Captured = {};
    const valid = JSON.stringify({ type: "thread.started", thread_id: "th_ok" });
    const res = await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker,
      runner: captureRunner(`codex deprecation warning\n${valid}\n`, captured),
    });

    const events = broker.replay(job.id);
    const parseErrors = events.filter((e) => e.type === "parse_error");
    expect(parseErrors).toHaveLength(1);
    expect(JSON.parse(parseErrors[0]?.payload ?? "{}").line).toBe("codex deprecation warning");
    // The valid line after the garbage is still parsed.
    expect(res.sessionId).toBe("th_ok");
  });

  it("honours an explicit CLI path override", async () => {
    const job = createJob({ repoId, issueNumber: 2, agent: "codex" }, db);
    const captured: Captured = {};
    await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      provider: codexProvider,
      command: "/opt/codex/bin/codex",
      runner: captureRunner(codexFixture(), captured),
    });
    expect(captured.cmd).toBe("/opt/codex/bin/codex");
  });
});

describe("resumeAgentSession fallback", () => {
  it("starts a fresh session when the provider cannot resume", async () => {
    const noResume: AgentProvider = {
      ...codexProvider,
      supportsResume: false,
      buildResumeArgs: () => null,
      buildStartArgs: () => ["FRESH-START"],
    };
    const job = createJob({ repoId, issueNumber: 3, agent: "codex" }, db);
    const captured: Captured = {};
    await resumeAgentSession(getJob(job.id, db) as never, "th-1", "CI log", "/work", {
      db,
      broker: new LogBroker(db),
      provider: noResume,
      runner: captureRunner(codexFixture(), captured),
    });
    expect(captured.args).toEqual(["FRESH-START"]);
  });
});
