import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobEvents } from "@/lib/db/schema";
import { requeueJobWithEscalation } from "@/lib/orchestrator/escalation";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function makeRepo(escalate: boolean, agent: "claude" | "codex" = "claude") {
  return addRepo(
    {
      path: "/r",
      name: "acme",
      agent,
      defaultModel: agent === "codex" ? "gpt-5-mini" : "claude-haiku-4-5",
      escalateModelOnRetry: escalate,
    },
    db,
  );
}

function failedJob(repoId: number, opts: { model?: string; agent?: string } = {}) {
  const job = createJob(
    { repoId, issueNumber: 1, model: opts.model ?? "claude-haiku-4-5", agent: opts.agent },
    db,
  );
  transitionJob(job.id, "working", {}, db);
  transitionJob(job.id, "needs_human", {}, db);
  return job;
}

function eventPayloads(jobId: number): string[] {
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .all()
    .map((e) => e.payload);
}

describe("requeueJobWithEscalation", () => {
  it("escalates a requeued needs_human job to the next-stronger model", () => {
    const repo = makeRepo(true);
    const job = failedJob(repo.id);

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.status).toBe("queued");
    expect(requeued.model).toBe("claude-sonnet-4-5");
    expect(getJob(job.id, db)?.model).toBe("claude-sonnet-4-5");
  });

  it("records an escalation event on the job timeline", () => {
    const repo = makeRepo(true);
    const job = failedJob(repo.id);

    requeueJobWithEscalation(job.id, db);

    const payloads = eventPayloads(job.id).join("\n");
    expect(payloads).toContain("model_escalated");
    expect(payloads).toContain("claude-haiku-4-5");
    expect(payloads).toContain("claude-sonnet-4-5");
  });

  it("leaves the model unchanged with the flag off (default)", () => {
    const repo = makeRepo(false);
    const job = failedJob(repo.id);

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.status).toBe("queued");
    expect(requeued.model).toBe("claude-haiku-4-5");
    expect(eventPayloads(job.id).join("\n")).not.toContain("model_escalated");
  });

  it("caps at the strongest model and still requeues", () => {
    const repo = makeRepo(true);
    const job = failedJob(repo.id, { model: "claude-opus-4-8" });

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.status).toBe("queued");
    expect(requeued.model).toBe("claude-opus-4-8");
    expect(eventPayloads(job.id).join("\n")).not.toContain("model_escalated");
  });

  it("walks the codex ladder for codex jobs", () => {
    const repo = makeRepo(true, "codex");
    const job = failedJob(repo.id, { model: "gpt-5-mini", agent: "codex" });

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.model).toBe("gpt-5");
  });

  it("does not escalate an interrupted job (not a failed attempt)", () => {
    const repo = makeRepo(true);
    const job = createJob({ repoId: repo.id, issueNumber: 2, model: "claude-haiku-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "interrupted", {}, db);

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.status).toBe("queued");
    expect(requeued.model).toBe("claude-haiku-4-5");
  });

  it("does not escalate a waiting_limit job (it resumes its session)", () => {
    const repo = makeRepo(true);
    const job = createJob({ repoId: repo.id, issueNumber: 3, model: "claude-haiku-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "waiting_limit", { limitKind: "five_hour", sessionId: "s1" }, db);

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.status).toBe("queued");
    expect(requeued.model).toBe("claude-haiku-4-5");
  });

  it("leaves a model outside the agent's ladder unchanged", () => {
    const repo = makeRepo(true);
    const job = failedJob(repo.id, { model: "some/openrouter-model:free" });

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.status).toBe("queued");
    expect(requeued.model).toBe("some/openrouter-model:free");
  });

  it("throws for an unknown job id", () => {
    expect(() => requeueJobWithEscalation(999, db)).toThrow(/not found/);
  });

  it("clears the prior attempt's finishedAt and errorMessage on requeue (issue #381)", () => {
    const repo = makeRepo(true);
    const job = createJob({ repoId: repo.id, issueNumber: 1, model: "claude-haiku-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(
      job.id,
      "needs_human",
      { errorMessage: "previous attempt failed" },
      db,
    );
    expect(parked.finishedAt).toBeTypeOf("number");

    const requeued = requeueJobWithEscalation(job.id, db);

    expect(requeued.finishedAt).toBeNull();
    expect(requeued.errorMessage).toBeNull();
  });
});
