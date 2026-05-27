import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import { resumeClaudeSession } from "@/lib/orchestrator/claude-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { saveTemplate } from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";
import { LogBroker } from "@/lib/stream/broker";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r", defaultModel: "claude-opus-4-7" }, db).id;
});

describe("resumeClaudeSession", () => {
  it("invokes claude with resume args and the recorded session id", async () => {
    const captured: string[][] = [];
    const runner: StreamRunner = (_cmd, args, _cwd, _cb: StreamCallbacks): StreamHandle => {
      captured.push(args);
      return { done: Promise.resolve(0), abort: () => {} };
    };
    const job = createJob({ repoId, issueNumber: 1 }, db);
    await resumeClaudeSession(job, "sess-abc", "CI log here", "/work", {
      runner,
      db,
      broker: new LogBroker(db),
    });
    expect(captured[0]).toContain("--resume");
    expect(captured[0]).toContain("sess-abc");
    expect(captured[0]).toContain("claude-haiku-4-5");
    expect(getJob(job.id, db)).toBeDefined();
  });

  it("uses the repo's ci-fix template with the failed log", async () => {
    saveTemplate({ repoId, name: TEMPLATE_NAMES.ciFix, content: "FIXLOG: $CI_LOG" }, db);
    let seenPrompt = "";
    const runner: StreamRunner = (_cmd, args, _cwd, _cb: StreamCallbacks): StreamHandle => {
      seenPrompt = args[args.indexOf("-p") + 1] ?? "";
      return { done: Promise.resolve(0), abort: () => {} };
    };
    const job = createJob({ repoId, issueNumber: 2 }, db);
    await resumeClaudeSession(job, "sess-1", "BOOM", "/work", {
      runner,
      db,
      broker: new LogBroker(db),
    });
    expect(seenPrompt).toContain("FIXLOG: BOOM");
  });

  it("persists cost and tokens additively onto the existing job totals", async () => {
    const result =
      '{"type":"result","subtype":"success","session_id":"sess-r","is_error":false,' +
      '"total_cost_usd":0.02,"usage":{"input_tokens":500,"output_tokens":100}}\n';
    const runner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
      cb.onStdout(result);
      return { done: Promise.resolve(0), abort: () => {} };
    };
    const job = createJob({ repoId, issueNumber: 3 }, db);
    // Seed prior usage from the initial session.
    db.update(jobs)
      .set({ costUsd: 0.05, totalInputTokens: 1000, totalOutputTokens: 200 })
      .where(eq(jobs.id, job.id))
      .run();

    await resumeClaudeSession(getJob(job.id, db) as never, "sess-r", "log", "/work", {
      runner,
      db,
      broker: new LogBroker(db),
    });

    const after = getJob(job.id, db);
    expect(after?.costUsd).toBeCloseTo(0.07, 5);
    expect(after?.totalInputTokens).toBe(1500);
    expect(after?.totalOutputTokens).toBe(300);
  });
});
