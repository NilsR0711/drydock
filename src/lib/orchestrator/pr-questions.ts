import { desc, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type PrQuestion, prQuestions } from "@/lib/db/schema";

/**
 * Data access for "Ask about this PR" questions (issue #55). A question is
 * created in the `answering` state and later transitioned to `answered` (with
 * the agent's reply) or `error` (with a reason) by the QA driver. Reads are
 * always scoped to a single job so answers never cross PRs.
 */

/** Insert a new question for a job's PR in the `answering` state. */
export function createPrQuestion(
  input: { jobId: number; prNumber: number; question: string },
  db: DB = getDb(),
): PrQuestion {
  return db
    .insert(prQuestions)
    .values({
      jobId: input.jobId,
      prNumber: input.prNumber,
      question: input.question,
      status: "answering",
    })
    .returning()
    .get();
}

export function getPrQuestion(id: number, db: DB = getDb()): PrQuestion | undefined {
  return db.select().from(prQuestions).where(eq(prQuestions.id, id)).get();
}

/** A job's questions, newest first. */
export function listPrQuestions(jobId: number, db: DB = getDb()): PrQuestion[] {
  return db
    .select()
    .from(prQuestions)
    .where(eq(prQuestions.jobId, jobId))
    .orderBy(desc(prQuestions.createdAt), desc(prQuestions.id))
    .all();
}

/** Store the agent's reply and flip the question to `answered`. */
export function markQuestionAnswered(id: number, answer: string, db: DB = getDb()): void {
  db.update(prQuestions)
    .set({ status: "answered", answer, errorMessage: null, updatedAt: nowSeconds() })
    .where(eq(prQuestions.id, id))
    .run();
}

/** Record why answering failed and flip the question to `error`. */
export function markQuestionError(id: number, message: string, db: DB = getDb()): void {
  db.update(prQuestions)
    .set({ status: "error", errorMessage: message, updatedAt: nowSeconds() })
    .where(eq(prQuestions.id, id))
    .run();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
