import { z } from "zod";
import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { PrQuestion } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import { MAX_QUESTION_CHARS, type PrAnswerGenerator } from "@/lib/issues/pr-question";
import { logError } from "@/lib/log/logger";
import { commandForAgent } from "./agent-command";
import { getJob } from "./jobs";
import { runPrQuestion } from "./pr-question-driver";
import { createPrQuestion, markQuestionError } from "./pr-questions";

/**
 * The capability layer for "Ask about this PR" (issue #55), shared by every
 * surface that exposes it: the dashboard Server Action, the `ask_pr_question`
 * MCP tool, and the REST endpoint (issue #296). It owns question validation,
 * job/PR lookup, persistence of the `answering` record, and kick-off of the
 * read-only QA driver — so the three surfaces stay byte-for-byte consistent and
 * none of them re-implements the lifecycle.
 */

/** Question validation shared by every surface (dashboard, MCP, REST). */
export const questionSchema = z
  .string()
  .trim()
  .min(1, "Ask a non-empty question.")
  .max(MAX_QUESTION_CHARS, `Keep the question under ${MAX_QUESTION_CHARS} characters.`);

/**
 * Test seam mirroring `__setForgeFactory`: when set, this generator is used
 * instead of spawning a one-shot agent, so MCP/REST surfaces can be exercised
 * end-to-end without a real CLI. Null in production.
 */
let answerGeneratorOverride: PrAnswerGenerator | null = null;

/** Inject (or clear with `null`) the QA answer generator for tests. */
export function __setPrAnswerGenerator(generate: PrAnswerGenerator | null): void {
  answerGeneratorOverride = generate;
}

export interface StartPrQuestionResult {
  /** The persisted question, freshly created in the `answering` state. */
  record: PrQuestion;
  /**
   * Resolves when the background QA run reaches a terminal state. The run never
   * throws — it persists its own `answered`/`error` outcome — so callers either
   * ignore this (fire-and-forget: dashboard, REST) or await it (MCP, which
   * returns the answer in-band).
   */
  done: Promise<void>;
}

/**
 * Validate a question, resolve its job's open PR, persist it in the `answering`
 * state, and kick off the read-only QA driver. Throws synchronously on a bad
 * question, an unknown job, a job without a PR, or an unknown repo — before any
 * record is created — so every surface reports the same errors the same way.
 */
export function startPrQuestion(
  jobId: number,
  question: string,
  db: DB = getDb(),
): StartPrQuestionResult {
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
  // Fire-and-forget at the driver level: the QA run can take up to a few minutes
  // and persists its own terminal state. It never rejects, so the returned
  // promise is always safe to ignore or await.
  const done = runPrQuestion({
    questionId: record.id,
    job,
    prNumber: job.prNumber,
    question: text,
    forge,
    db,
    provider,
    command,
    model: job.model ?? repo.defaultModel,
    generate: answerGeneratorOverride ?? undefined,
  }).catch((err) => {
    logError(`[pr-question] background run failed for question ${record.id}`, err);
    // runPrQuestion is contracted never to throw (it persists its own terminal
    // state), but if it ever does the record would be stranded in `answering` —
    // MCP awaits `done` and returns the row, and REST pollers would wait
    // forever. Force a terminal error so the answering → answered | error
    // contract always holds once `done` resolves.
    const message = err instanceof Error ? err.message : String(err);
    try {
      markQuestionError(record.id, `Answering failed: ${message}`.slice(0, 500), db);
    } catch (markErr) {
      logError(`[pr-question] failed to mark question ${record.id} as errored`, markErr);
    }
  });

  return { record, done };
}
