import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentProvider } from "@/lib/agents/registry";

/** Wrap plain text in the NDJSON envelope that stream-json one-shots emit. */
function oneShotNdjson(text: string): string {
  return `${[
    JSON.stringify({ type: "system", session_id: "s1", model: "claude-opus-4-8" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  ].join("\n")}\n`;
}

import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import type { IssueDetail, PrCheck } from "@/lib/github/gh";
import type { PrQuestionContext } from "@/lib/issues/pr-question";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import {
  assembleContext,
  buildAnswerGenerator,
  type QuestionForge,
  runPrQuestion,
} from "@/lib/orchestrator/pr-question-driver";
import { createPrQuestion, getPrQuestion } from "@/lib/orchestrator/pr-questions";
import { openFeedbackItem } from "@/lib/orchestrator/review-feedback";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

const provider = getAgentProvider("claude");

function fakeRunner(result: Partial<CommandResult>): CommandRunner {
  return vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, ...result }));
}

function fakeForge(over: Partial<Record<keyof QuestionForge, unknown>> = {}): QuestionForge {
  return {
    prDiff: vi.fn(async () => "diff --git a/x b/x\n+y"),
    prChecks: vi.fn(
      async (): Promise<PrCheck[]> => [
        { name: "test", state: "pass" },
        { name: "lint", state: "fail" },
      ],
    ),
    viewIssue: vi.fn(
      async (): Promise<IssueDetail> => ({
        number: 7,
        title: "Add thing",
        body: "do A and B",
        state: "open",
        labels: [],
        comments: [],
      }),
    ),
    ...over,
  } as QuestionForge;
}

function setup() {
  const repo = addRepo({ path: "/r", name: "r" }, db) as Repo;
  syncIssuesFromGh(repo.id, [{ number: 7, title: "Add thing", labels: [] }], db);
  const job = getJob(createJob({ repoId: repo.id, issueNumber: 7 }, db).id, db) as Job;
  return { repo, job };
}

const input = {
  question: "why?",
  context: {
    prNumber: 1,
    branch: "b",
    jobStatus: "ci_running",
    issueNumber: 7,
    issueTitle: "T",
    issueBody: "body",
    checks: [],
    feedback: [],
    log: [],
    diff: "diff",
  } satisfies PrQuestionContext,
};

describe("buildAnswerGenerator", () => {
  it("returns the trimmed answer from a clean one-shot run", async () => {
    const runner = fakeRunner({ stdout: oneShotNdjson("  here is the answer  ") });
    const gen = buildAnswerGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner,
    });
    expect(await gen(input)).toBe("here is the answer");
  });

  it("returns null on a non-zero exit", async () => {
    const gen = buildAnswerGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner: fakeRunner({ exitCode: 1, stdout: "partial" }),
    });
    expect(await gen(input)).toBeNull();
  });

  it("returns null on an empty answer", async () => {
    const gen = buildAnswerGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner: fakeRunner({ stdout: "   \n " }),
    });
    expect(await gen(input)).toBeNull();
  });

  it("returns null when the runner throws (e.g. a timeout)", async () => {
    const gen = buildAnswerGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner: vi.fn(async () => {
        throw new Error("timed out");
      }),
    });
    expect(await gen(input)).toBeNull();
  });

  it("passes a bounded timeout to the runner", async () => {
    const runner = fakeRunner({ stdout: "a" });
    const gen = buildAnswerGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner,
      timeoutMs: 4321,
    });
    await gen(input);
    const opts = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[3];
    expect(opts).toMatchObject({ timeoutMs: 4321 });
  });
});

describe("assembleContext", () => {
  it("gathers diff, checks, issue, feedback, and recent log lines", async () => {
    const { job } = setup();
    openFeedbackItem(
      {
        jobId: job.id,
        prNumber: 3,
        threadId: "t1",
        reviewer: "alice",
        classification: "actionable",
      },
      db,
    );
    const forge = fakeForge();
    const ctx = await assembleContext({ job, prNumber: 3, forge, db });

    expect(ctx.prNumber).toBe(3);
    expect(ctx.branch).toBe(job.branch);
    expect(ctx.jobStatus).toBe(job.status);
    expect(ctx.issueTitle).toBe("Add thing");
    expect(ctx.diff).toContain("+y");
    expect(ctx.checks.map((c) => c.name)).toEqual(["test", "lint"]);
    expect(ctx.feedback.join("\n")).toContain("alice");
  });

  it("degrades gracefully when forge calls fail", async () => {
    const { job } = setup();
    const forge = fakeForge({
      prDiff: vi.fn(async () => {
        throw new Error("net down");
      }),
      prChecks: vi.fn(async () => {
        throw new Error("net down");
      }),
      viewIssue: vi.fn(async () => {
        throw new Error("net down");
      }),
    });
    const ctx = await assembleContext({ job, prNumber: 3, forge, db });
    expect(ctx.diff).toBe("");
    expect(ctx.checks).toEqual([]);
    // Falls back to the locally cached issue title.
    expect(ctx.issueTitle).toBe("Add thing");
  });
});

describe("runPrQuestion", () => {
  function passDeps(
    forge: QuestionForge,
    generate: () => Promise<string | null>,
    job: Job,
    qId: number,
  ) {
    return {
      questionId: qId,
      job,
      prNumber: 55,
      question: "what's left to do here?",
      forge,
      db,
      provider,
      command: "claude",
      model: "m",
      generate: vi.fn(generate),
    };
  }

  it("stores the answer and flips the question to answered", async () => {
    const { job } = setup();
    const q = createPrQuestion({ jobId: job.id, prNumber: 55, question: "q" }, db);
    await runPrQuestion(passDeps(fakeForge(), async () => "the wiring is done", job, q.id));
    const updated = getPrQuestion(q.id, db);
    expect(updated?.status).toBe("answered");
    expect(updated?.answer).toBe("the wiring is done");
  });

  it("marks the question as error on an empty/failed agent response", async () => {
    const { job } = setup();
    const q = createPrQuestion({ jobId: job.id, prNumber: 55, question: "q" }, db);
    await runPrQuestion(passDeps(fakeForge(), async () => null, job, q.id));
    const updated = getPrQuestion(q.id, db);
    expect(updated?.status).toBe("error");
    expect(updated?.errorMessage).toBeTruthy();
    expect(updated?.answer).toBeNull();
  });

  it("never throws when context assembly fails, marking the question error", async () => {
    const { job } = setup();
    const q = createPrQuestion({ jobId: job.id, prNumber: 55, question: "q" }, db);
    await expect(
      runPrQuestion({
        ...passDeps(fakeForge(), async () => "unused", job, q.id),
        // A generator that throws stands in for any unexpected internal failure.
        generate: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    ).resolves.toBeUndefined();
    expect(getPrQuestion(q.id, db)?.status).toBe("error");
  });

  it("redacts secrets from the stored answer", async () => {
    const { job } = setup();
    const q = createPrQuestion({ jobId: job.id, prNumber: 55, question: "q" }, db);
    await runPrQuestion(
      passDeps(
        fakeForge(),
        async () => "token ghp_0123456789012345678901234567890123456789",
        job,
        q.id,
      ),
    );
    expect(getPrQuestion(q.id, db)?.answer).not.toContain(
      "ghp_0123456789012345678901234567890123456789",
    );
  });
});
