import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { codexProvider } from "@/lib/agents/codex";
import type { AgentProvider } from "@/lib/agents/types";
import { createDb, type DB } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import { resumeAgentSession, spawnAgentSession } from "@/lib/orchestrator/agent-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker } from "@/lib/stream/broker";
import { StreamJsonParser } from "@/lib/stream/parser";

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

  it("bounds a never-resolving runner by the wall-clock timeout and aborts it (issue #47)", async () => {
    const job = createJob({ repoId, issueNumber: 5, agent: "codex" }, db);
    let aborted = false;
    const hangingRunner: StreamRunner = () => ({
      done: new Promise<number>(() => {}), // never resolves
      abort: () => {
        aborted = true;
      },
    });
    const res = await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      runner: hangingRunner,
      timeoutMs: 20,
    });
    expect(res.timedOut).toBe(true);
    expect(aborted).toBe(true);
  });

  // A claude-shaped assistant event carrying token usage. Paired with a provider
  // whose estimateCost prices output tokens at $0.001 each, it lets a test drive
  // the live cost estimate deterministically across the per-job cap (issue #57).
  function assistantUsage(outputTokens: number): string {
    return `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        usage: { output_tokens: outputTokens },
      },
    })}\n`;
  }

  // Prices output tokens at a flat $0.001 each and parses the claude stream so
  // the cost guard's live estimate is fully deterministic in tests.
  const pricedProvider: AgentProvider = {
    ...codexProvider,
    createParser: () => new StreamJsonParser(),
    estimateCost: (_m, _in, out) => out * 0.001,
  };

  it("aborts the session mid-stream when accumulated cost crosses the per-job cap (issue #57)", async () => {
    const job = createJob({ repoId, issueNumber: 8, agent: "codex" }, db);
    let aborted = false;
    const hangingRunner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks) => {
      cb.onStdout(assistantUsage(1000)); // 1000 tok → $1.00, over the $0.50 cap
      return {
        done: new Promise<number>(() => {}), // never resolves on its own
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner: hangingRunner,
      costCapUsd: 0.5,
    });
    expect(res.costExceeded).toBe(true);
    expect(aborted).toBe(true);
    // The partial cost is persisted so it still counts toward the day's spend.
    expect(getJob(job.id, db)?.costUsd).toBeGreaterThan(0);
  });

  it("does not abort when the live cost stays under the per-job cap (issue #57)", async () => {
    const job = createJob({ repoId, issueNumber: 9, agent: "codex" }, db);
    let aborted = false;
    const runner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
      cb.onStdout(assistantUsage(100)); // 100 tok → $0.10, under the $0.50 cap
      return {
        done: Promise.resolve(0),
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner,
      costCapUsd: 0.5,
    });
    expect(res.costExceeded).toBe(false);
    expect(aborted).toBe(false);
  });

  it("treats a zero/unset cap as no per-job ceiling (issue #57)", async () => {
    const job = createJob({ repoId, issueNumber: 10, agent: "codex" }, db);
    let aborted = false;
    const runner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
      cb.onStdout(assistantUsage(100_000)); // $100, but the cap is off
      return {
        done: Promise.resolve(0),
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner,
      costCapUsd: 0,
    });
    expect(res.costExceeded).toBe(false);
    expect(aborted).toBe(false);
  });

  it("does not flag a normally-exiting session as timed out", async () => {
    const job = createJob({ repoId, issueNumber: 6, agent: "codex" }, db);
    const captured: Captured = {};
    const res = await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      runner: captureRunner(codexFixture(), captured),
      timeoutMs: 60_000,
    });
    expect(res.timedOut).toBe(false);
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

  it("aborts a resume that crosses the per-job cost cap (issue #57)", async () => {
    const job = createJob({ repoId, issueNumber: 11, agent: "codex" }, db);
    let aborted = false;
    const provider: AgentProvider = {
      ...codexProvider,
      createParser: () => new StreamJsonParser(),
      estimateCost: (_m, _in, out) => out * 0.001,
    };
    const assistant = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fixing" }],
        usage: { output_tokens: 1000 },
      },
    })}\n`;
    const hangingRunner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks) => {
      cb.onStdout(assistant);
      return {
        done: new Promise<number>(() => {}),
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await resumeAgentSession(getJob(job.id, db) as never, "th-1", "CI log", "/work", {
      db,
      broker: new LogBroker(db),
      provider,
      runner: hangingRunner,
      costCapUsd: 0.5,
    });
    expect(res.costExceeded).toBe(true);
    expect(aborted).toBe(true);
  });

  it("bounds a never-resolving resume runner and aborts it (issue #47)", async () => {
    const job = createJob({ repoId, issueNumber: 7, agent: "codex" }, db);
    let aborted = false;
    const hangingRunner: StreamRunner = () => ({
      done: new Promise<number>(() => {}),
      abort: () => {
        aborted = true;
      },
    });
    const res = await resumeAgentSession(getJob(job.id, db) as never, "th-1", "CI log", "/work", {
      db,
      broker: new LogBroker(db),
      runner: hangingRunner,
      timeoutMs: 20,
    });
    expect(res.timedOut).toBe(true);
    expect(aborted).toBe(true);
  });
});

describe("grace-window drain after force-abort (issue #97)", () => {
  // Prices output tokens at a flat $0.001 each so costs are deterministic.
  const pricedProvider: AgentProvider = {
    ...codexProvider,
    createParser: () => new StreamJsonParser(),
    estimateCost: (_m, _in, out) => out * 0.001,
  };

  function assistantUsage(outputTokens: number): string {
    return `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        usage: { output_tokens: outputTokens },
      },
    })}\n`;
  }

  it("includes grace-window tokens in persisted cost after cost-cap abort (spawn)", async () => {
    // Initial chunk: 600 tok → $0.60, crosses the $0.50 cap → costTripped fires, abort() called.
    // abort() schedules (via Promise.resolve().then) a late chunk of 400 more tokens and
    // then resolves done. With the fix the session waits for done before finalising cost,
    // so the total should be 1000 tok → $1.00. With the current code it is ~$0.60.
    const job = createJob({ repoId, issueNumber: 30, agent: "codex" }, db);

    let resolvesDone!: (code: number) => void;
    let capturedOnStdout!: (chunk: string) => void;

    const graceRunner: StreamRunner = (_cmd, _args, _cwd, cb) => {
      capturedOnStdout = cb.onStdout;
      // Emit the first chunk synchronously — this crosses the cap.
      cb.onStdout(assistantUsage(600));
      return {
        done: new Promise<number>((res) => {
          resolvesDone = res;
        }),
        abort: () => {
          // Simulate the grace window: after abort the process emits a bit more
          // output before exiting. setTimeout(0) ensures this fires in a later
          // macrotask — after awaitBounded has already resolved and returned to
          // spawnAgentSession. With the current code spawnAgentSession finalises
          // cost before this fires; the fix must await done even after abort.
          setTimeout(() => {
            capturedOnStdout(assistantUsage(400));
            resolvesDone(0);
          }, 0);
        },
      };
    };

    const res = await spawnAgentSession(getJob(job.id, db) as never, "p", "/tmp/r", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner: graceRunner,
      costCapUsd: 0.5,
    });

    expect(res.costExceeded).toBe(true);
    // 1000 tokens × $0.001 = $1.00 — only true once the fix is in place.
    expect(res.costUsd).toBeCloseTo(1.0, 5);
    expect(getJob(job.id, db)?.costUsd).toBeCloseTo(1.0, 5);
  });

  it("includes grace-window tokens in persisted cost after cost-cap abort (resume)", async () => {
    // Same scenario as above but exercised through resumeAgentSession.
    const job = createJob({ repoId, issueNumber: 31, agent: "codex" }, db);

    let resolvesDone!: (code: number) => void;
    let capturedOnStdout!: (chunk: string) => void;

    const graceRunner: StreamRunner = (_cmd, _args, _cwd, cb) => {
      capturedOnStdout = cb.onStdout;
      cb.onStdout(assistantUsage(600));
      return {
        done: new Promise<number>((res) => {
          resolvesDone = res;
        }),
        abort: () => {
          // Simulate the grace window: fires in a later macrotask so it lands
          // after the current awaitBounded promise has already resolved.
          setTimeout(() => {
            capturedOnStdout(assistantUsage(400));
            resolvesDone(0);
          }, 0);
        },
      };
    };

    const res = await resumeAgentSession(
      getJob(job.id, db) as never,
      "th-grace",
      "CI log",
      "/tmp/r",
      {
        db,
        broker: new LogBroker(db),
        provider: pricedProvider,
        runner: graceRunner,
        costCapUsd: 0.5,
      },
    );

    expect(res.costExceeded).toBe(true);
    // 1000 tokens × $0.001 = $1.00 — only true once the fix is in place.
    expect(res.costUsd).toBeCloseTo(1.0, 5);
    expect(getJob(job.id, db)?.costUsd).toBeCloseTo(1.0, 5);
  });
});

describe("resumeAgentSession cumulative cost guard (issue #94)", () => {
  // Prices output tokens at a flat $0.001 each so costs are deterministic.
  const pricedProvider: AgentProvider = {
    ...codexProvider,
    createParser: () => new StreamJsonParser(),
    estimateCost: (_m, _in, out) => out * 0.001,
  };

  function assistantUsage(outputTokens: number): string {
    return `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fixing" }],
        usage: { output_tokens: outputTokens },
      },
    })}\n`;
  }

  it("aborts a resume when prior job cost plus this invocation crosses the cap", async () => {
    // Prior spend: $0.40. Cap: $0.50. This resume adds 150 tok → $0.15.
    // Cumulative: $0.40 + $0.15 = $0.55 > $0.50 → should abort.
    const job = createJob({ repoId, issueNumber: 20, agent: "codex" }, db);
    db.update(jobs).set({ costUsd: 0.4 }).where(eq(jobs.id, job.id)).run();
    let aborted = false;
    const hangingRunner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks) => {
      cb.onStdout(assistantUsage(150));
      return {
        done: new Promise<number>(() => {}),
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await resumeAgentSession(getJob(job.id, db) as never, "th-1", "CI log", "/work", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner: hangingRunner,
      costCapUsd: 0.5,
    });
    expect(res.costExceeded).toBe(true);
    expect(aborted).toBe(true);
  });

  it("does not abort a resume when prior cost plus this invocation stays under the cap", async () => {
    // Prior spend: $0.30. Cap: $0.50. This resume adds 50 tok → $0.05.
    // Cumulative: $0.30 + $0.05 = $0.35 < $0.50 → should not abort.
    const job = createJob({ repoId, issueNumber: 21, agent: "codex" }, db);
    db.update(jobs).set({ costUsd: 0.3 }).where(eq(jobs.id, job.id)).run();
    let aborted = false;
    const runner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
      cb.onStdout(assistantUsage(50));
      return {
        done: Promise.resolve(0),
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await resumeAgentSession(getJob(job.id, db) as never, "th-1", "CI log", "/work", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner,
      costCapUsd: 0.5,
    });
    expect(res.costExceeded).toBe(false);
    expect(aborted).toBe(false);
  });

  it("aborts immediately when prior cost alone already meets or exceeds the cap", async () => {
    // Prior spend: $0.55. Cap: $0.50. Even 1 token of new spend should abort.
    const job = createJob({ repoId, issueNumber: 22, agent: "codex" }, db);
    db.update(jobs).set({ costUsd: 0.55 }).where(eq(jobs.id, job.id)).run();
    let aborted = false;
    const hangingRunner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks) => {
      cb.onStdout(assistantUsage(1));
      return {
        done: new Promise<number>(() => {}),
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await resumeAgentSession(getJob(job.id, db) as never, "th-1", "CI log", "/work", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner: hangingRunner,
      costCapUsd: 0.5,
    });
    expect(res.costExceeded).toBe(true);
    expect(aborted).toBe(true);
  });

  it("ignores prior cost when no cap is configured", async () => {
    // Prior spend: $99. No cap → should never abort.
    const job = createJob({ repoId, issueNumber: 23, agent: "codex" }, db);
    db.update(jobs).set({ costUsd: 99 }).where(eq(jobs.id, job.id)).run();
    let aborted = false;
    const runner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
      cb.onStdout(assistantUsage(1));
      return {
        done: Promise.resolve(0),
        abort: () => {
          aborted = true;
        },
      };
    };
    const res = await resumeAgentSession(getJob(job.id, db) as never, "th-1", "CI log", "/work", {
      db,
      broker: new LogBroker(db),
      provider: pricedProvider,
      runner,
      costCapUsd: 0,
    });
    expect(res.costExceeded).toBe(false);
    expect(aborted).toBe(false);
  });
});
