"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import { startPrQuestion } from "./pr-question-service";

/**
 * Ask a free-text question about a job's PR (issue #55). Persists the question
 * in the `answering` state and kicks off the read-only QA agent in the
 * background (via {@link startPrQuestion}) so the action returns immediately and
 * the UI can poll for the answer. The background run never throws: it
 * transitions the question to `answered` or `error` on its own.
 */
export async function askPrQuestionAction(jobId: number, question: string) {
  const db = getDb();
  // Fire-and-forget: the dashboard polls `listPrQuestions` for the terminal
  // state, so we do not await the run here.
  const { record } = startPrQuestion(jobId, question, db);
  revalidatePath(`/jobs/${jobId}`);
  return record;
}
