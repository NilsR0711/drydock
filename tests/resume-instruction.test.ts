import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobEvents } from "@/lib/db/schema";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { resumeJobWithInstruction } from "@/lib/orchestrator/resume-instruction";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", defaultModel: "claude-opus-4-8" }, db).id;
});

/** Drive a fresh job to needs_human so it can be unblocked with an instruction. */
function parkedJob(issueNumber = 1, patch: Partial<Job> = {}) {
  const job = createJob({ repoId, issueNumber }, db);
  transitionJob(job.id, "working", {}, db);
  transitionJob(
    job.id,
    "needs_human",
    { branch: "drydock/issue-1-job-1", sessionId: "s1", ...patch },
    db,
  );
  return getJob(job.id, db) as Job;
}

describe("resumeJobWithInstruction (issue #257)", () => {
  it("requeues a needs_human job carrying the typed instruction", () => {
    const job = parkedJob();
    const result = resumeJobWithInstruction(job.id, "use the existing xByY helper", db);

    expect(result.status).toBe("queued");
    expect(result.humanInstruction).toBe("use the existing xByY helper");
    // The branch + session id are preserved so the resumed run continues prior work.
    expect(result.branch).toBe("drydock/issue-1-job-1");
    expect(result.sessionId).toBe("s1");
  });

  it("records the instruction as a job event so the log shows what was asked", () => {
    const job = parkedJob();
    resumeJobWithInstruction(job.id, "skip the migration, it's already applied", db);

    const events = db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)).all();
    const instructionEvent = events.find((e) => e.type === "human_instruction");
    expect(instructionEvent).toBeDefined();
    expect(JSON.parse(instructionEvent?.payload ?? "{}")).toEqual({
      instruction: "skip the migration, it's already applied",
    });
  });

  it("trims surrounding whitespace from the instruction", () => {
    const job = parkedJob();
    const result = resumeJobWithInstruction(job.id, "  do the thing  \n", db);
    expect(result.humanInstruction).toBe("do the thing");
  });

  it("rejects a blank instruction", () => {
    const job = parkedJob();
    expect(() => resumeJobWithInstruction(job.id, "   \n ", db)).toThrow(/instruction/i);
    // The job stays parked — no accidental requeue on empty input.
    expect((getJob(job.id, db) as Job).status).toBe("needs_human");
  });

  it("throws for an unknown job", () => {
    expect(() => resumeJobWithInstruction(9999, "go", db)).toThrow(/not found/i);
  });

  it("clears the prior attempt's finishedAt and errorMessage on requeue (issue #381)", () => {
    const job = parkedJob(3, { errorMessage: "previous attempt failed" });
    expect(job.finishedAt).toBeTypeOf("number");

    const result = resumeJobWithInstruction(job.id, "try again with the new hint", db);

    expect(result.finishedAt).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it("refuses to resume a job that is not awaiting a human", () => {
    const job = createJob({ repoId, issueNumber: 2 }, db);
    transitionJob(job.id, "working", {}, db);
    expect(() => resumeJobWithInstruction(job.id, "go", db)).toThrow(/needs_human/);
    expect((getJob(job.id, db) as Job).status).toBe("working");
    // No instruction event was written for the rejected request.
    const events = db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)).all();
    expect(events.some((e) => e.type === "human_instruction")).toBe(false);
  });
});
