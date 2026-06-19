process.env.DRYDOCK_DB = ":memory:";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the driver so we can drive the rejection path; the rest of the
// service (validation, persistence, lookup) runs for real.
const { runPrQuestionMock } = vi.hoisted(() => ({ runPrQuestionMock: vi.fn() }));
vi.mock("@/lib/orchestrator/pr-question-driver", () => ({ runPrQuestion: runPrQuestionMock }));

import { getDb } from "@/lib/db/client";
import { jobs, prQuestions, repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import { MAX_QUESTION_CHARS } from "@/lib/issues/pr-question";
import { startPrQuestion } from "@/lib/orchestrator/pr-question-service";
import { getPrQuestion, listPrQuestions } from "@/lib/orchestrator/pr-questions";
import { saveSettings } from "@/lib/settings/service";

function seedJobWithPr(): number {
  const db = getDb();
  const repoId = db.insert(repos).values({ path: "/r", name: "r" }).returning().get().id;
  return db
    .insert(jobs)
    .values({ repoId, issueNumber: 1, status: "ci_running", prNumber: 7, agent: "claude" })
    .returning()
    .get().id;
}

describe("startPrQuestion (issue #296)", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(prQuestions).run();
    db.delete(jobs).run();
    db.delete(repos).run();
    saveSettings({ paused: false, draining: false, dailyCostLimitUsd: 10 }, db);
    runPrQuestionMock.mockReset();
    runPrQuestionMock.mockResolvedValue(undefined);
    __setForgeFactory(() => ({}) as never);
  });

  afterEach(() => {
    __setForgeFactory(null);
  });

  it("creates the question in the answering state and kicks off the driver", () => {
    const jobId = seedJobWithPr();
    const { record } = startPrQuestion(jobId, "why?", getDb());
    expect(record.status).toBe("answering");
    expect(record.question).toBe("why?");
    expect(runPrQuestionMock).toHaveBeenCalledTimes(1);
  });

  it("forces a terminal error when the driver rejects (terminal-state contract)", async () => {
    runPrQuestionMock.mockRejectedValueOnce(new Error("boom"));
    const jobId = seedJobWithPr();
    const { record, done } = startPrQuestion(jobId, "why?", getDb());
    await done;
    const updated = getPrQuestion(record.id, getDb());
    expect(updated?.status).toBe("error");
    expect(updated?.errorMessage).toMatch(/boom/);
  });

  it("trims the question and rejects an empty one before persisting", () => {
    const jobId = seedJobWithPr();
    expect(() => startPrQuestion(jobId, "   ", getDb())).toThrow();
    expect(listPrQuestions(jobId, getDb())).toHaveLength(0);
    expect(runPrQuestionMock).not.toHaveBeenCalled();
  });

  it("rejects a question over the length cap before persisting", () => {
    const jobId = seedJobWithPr();
    expect(() => startPrQuestion(jobId, "q".repeat(MAX_QUESTION_CHARS + 1), getDb())).toThrow();
    expect(listPrQuestions(jobId, getDb())).toHaveLength(0);
  });

  it("throws for an unknown job and a job without a PR before persisting", () => {
    expect(() => startPrQuestion(999, "why?", getDb())).toThrow(/not found/);
    const db = getDb();
    const repoId = db.insert(repos).values({ path: "/r2", name: "r2" }).returning().get().id;
    const noPr = db
      .insert(jobs)
      .values({ repoId, issueNumber: 2, status: "queued", agent: "claude" })
      .returning()
      .get().id;
    expect(() => startPrQuestion(noPr, "why?", getDb())).toThrow(/no PR/i);
    expect(runPrQuestionMock).not.toHaveBeenCalled();
  });
});
