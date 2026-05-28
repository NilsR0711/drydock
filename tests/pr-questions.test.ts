import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Repo } from "@/lib/db/schema";
import { createJob } from "@/lib/orchestrator/jobs";
import {
  createPrQuestion,
  getPrQuestion,
  listPrQuestions,
  markQuestionAnswered,
  markQuestionError,
} from "@/lib/orchestrator/pr-questions";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function setup() {
  const repo = addRepo({ path: "/r", name: "r" }, db) as Repo;
  const job = createJob({ repoId: repo.id, issueNumber: 7 }, db);
  return { repo, job };
}

describe("createPrQuestion", () => {
  it("stores a question in the answering state", () => {
    const { job } = setup();
    const q = createPrQuestion({ jobId: job.id, prNumber: 9, question: "why?" }, db);
    expect(q.status).toBe("answering");
    expect(q.question).toBe("why?");
    expect(q.prNumber).toBe(9);
    expect(q.answer).toBeNull();
  });
});

describe("getPrQuestion", () => {
  it("returns the stored question", () => {
    const { job } = setup();
    const created = createPrQuestion({ jobId: job.id, prNumber: 9, question: "q" }, db);
    expect(getPrQuestion(created.id, db)?.question).toBe("q");
  });

  it("returns undefined for an unknown id", () => {
    expect(getPrQuestion(999, db)).toBeUndefined();
  });
});

describe("listPrQuestions", () => {
  it("lists a job's questions newest first and scoped to that job", () => {
    const { job } = setup();
    const other = createJob({ repoId: job.repoId, issueNumber: 8 }, db);
    const first = createPrQuestion({ jobId: job.id, prNumber: 9, question: "first" }, db);
    const second = createPrQuestion({ jobId: job.id, prNumber: 9, question: "second" }, db);
    createPrQuestion({ jobId: other.id, prNumber: 10, question: "elsewhere" }, db);

    const rows = listPrQuestions(job.id, db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(second.id);
    expect(rows[1]?.id).toBe(first.id);
    expect(rows.every((r) => r.question !== "elsewhere")).toBe(true);
  });
});

describe("markQuestionAnswered", () => {
  it("stores the answer and flips status to answered", () => {
    const { job } = setup();
    const q = createPrQuestion({ jobId: job.id, prNumber: 9, question: "q" }, db);
    markQuestionAnswered(q.id, "the answer", db);
    const updated = getPrQuestion(q.id, db);
    expect(updated?.status).toBe("answered");
    expect(updated?.answer).toBe("the answer");
    expect(updated?.errorMessage).toBeNull();
  });
});

describe("markQuestionError", () => {
  it("records the error message and flips status to error", () => {
    const { job } = setup();
    const q = createPrQuestion({ jobId: job.id, prNumber: 9, question: "q" }, db);
    markQuestionError(q.id, "the agent returned an empty response", db);
    const updated = getPrQuestion(q.id, db);
    expect(updated?.status).toBe("error");
    expect(updated?.errorMessage).toBe("the agent returned an empty response");
    expect(updated?.answer).toBeNull();
  });
});
