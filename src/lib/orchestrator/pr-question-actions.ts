"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAgentProvider } from "@/lib/agents/registry";
import { getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { getForge } from "@/lib/forge/registry";
import { MAX_QUESTION_CHARS } from "@/lib/issues/pr-question";
import { commandForAgent } from "./agent-command";
import { getJob } from "./jobs";
import { runPrQuestion } from "./pr-question-driver";
import { createPrQuestion } from "./pr-questions";

const questionSchema = z
  .string()
  .trim()
  .min(1, "Ask a non-empty question.")
  .max(MAX_QUESTION_CHARS, `Keep the question under ${MAX_QUESTION_CHARS} characters.`);

/**
 * Ask a free-text question about a job's PR (issue #55). Persists the question
 * in the `answering` state, then kicks off the read-only QA agent in the
 * background so the action returns immediately and the UI can poll for the
 * answer. The background run never throws: it transitions the question to
 * `answered` or `error` on its own.
 */
export async function askPrQuestionAction(jobId: number, question: string) {
  const db = getDb();
  const text = questionSchema.parse(question);
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (job.prNumber == null) throw new Error("This job has no PR to ask about yet.");
  const repo = getRepo(job.repoId, db);
  if (!repo) throw new Error(`repo ${job.repoId} not found`);

  const record = createPrQuestion({ jobId, prNumber: job.prNumber, question: text }, db);

  const forge = getForge(repo);
  const provider = getAgentProvider(job.agent);
  const command = commandForAgent(provider, db);
  // Fire-and-forget: the QA run can take up to a few minutes, so we do not block
  // the action on it. It persists its own terminal state; failures are logged.
  void runPrQuestion({
    questionId: record.id,
    job,
    prNumber: job.prNumber,
    question: text,
    forge,
    db,
    provider,
    command,
    model: job.model ?? repo.defaultModel,
  }).catch((err) => {
    console.error(`[pr-question] background run failed for question ${record.id}`, err);
  });

  revalidatePath(`/jobs/${jobId}`);
  return record;
}
