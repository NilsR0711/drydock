import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentProvider } from "@/lib/agents/types";
import type { DB } from "@/lib/db/client";
import { type Job, jobEvents } from "@/lib/db/schema";
import type { CommandRunner } from "@/lib/exec/runner";
import type { IssueDetail, PrCheck } from "@/lib/github/gh";
import {
  buildQuestionPrompt,
  MAX_LOG_LINES,
  type PrAnswerGenerator,
  type PrCheckSummary,
  type PrQuestionContext,
  type PrQuestionInput,
  parseAnswer,
} from "@/lib/issues/pr-question";
import { listIssues } from "@/lib/issues/service";
import { redactSecrets } from "@/lib/log/redact";
import { recordEvent } from "./jobs";
import { buildOneShotGenerator, type OneShotGeneratorDeps } from "./one-shot-generator";
import { markQuestionAnswered, markQuestionError } from "./pr-questions";
import { ProviderLimitError } from "./provider-limit";
import { listFeedbackItems } from "./review-feedback";

/**
 * The driver-side glue for "Ask about this PR" (issue #55): assembling the
 * read-only context bundle, the one-shot QA agent generator, and the lifecycle
 * that drives a stored question from `answering` to `answered` or `error`. Pure
 * prompt/parse logic lives in `issues/pr-question.ts`. Like the verification
 * pass, every step is best-effort: a failed forge call degrades the context
 * rather than aborting, and an empty or failed agent response is recorded as an
 * error rather than thrown — a question can never corrupt a job or its PR.
 */

/**
 * Tight wall-clock bound on the QA one-shot (issue #55). This is a read-only
 * answer over a bounded context, not a coding session, so a multi-minute stall
 * means a hung process rather than legitimate work.
 */
export const PR_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;

/** The forge operations the QA pass needs; a best-effort subset of ForgeClient. */
export interface QuestionForge {
  prDiff(prNumber: number): Promise<string>;
  prChecks(prNumber: number): Promise<PrCheck[]>;
  viewIssue(issueNumber: number): Promise<IssueDetail>;
}

/**
 * A {@link PrAnswerGenerator} backed by a one-shot agent run. The CLI shape
 * comes from the repo's {@link AgentProvider}, and a tight timeout is enforced
 * by the runner. Best-effort: a non-zero exit, an empty answer, or a thrown
 * error (e.g. a timeout) all yield `null` — except a waitable provider limit
 * (issues #167/#430), which latches the agent and throws
 * {@link ProviderLimitError} so the caller defers instead of marking the
 * question errored against an exhausted quota.
 */
export function buildAnswerGenerator(deps: OneShotGeneratorDeps): PrAnswerGenerator {
  return buildOneShotGenerator<PrQuestionInput, string | null>(deps, {
    type: "pr-question",
    defaultTimeoutMs: PR_QUESTION_TIMEOUT_MS,
    buildPrompt: buildQuestionPrompt,
    onResult: (text) => parseAnswer(text),
    onExit: () => null,
    onError: () => null,
  });
}

/** Run an async forge read, returning a fallback on any failure (best-effort). */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** The locally cached issue title for a job, or a generic placeholder. */
function cachedIssueTitle(job: Job, db: DB): string {
  const title = listIssues(job.repoId, db).find((i) => i.number === job.issueNumber)?.title;
  return title ?? `Issue #${job.issueNumber}`;
}

/** The most recent activity-log lines for a job, oldest first. */
function recentLog(jobId: number, db: DB): string[] {
  const rows = db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(jobEvents.ts, jobEvents.id)
    .all();
  return rows.slice(-MAX_LOG_LINES).map((e) => `${e.type}: ${e.payload}`);
}

export interface AssembleContextDeps {
  job: Job;
  prNumber: number;
  forge: QuestionForge;
  db: DB;
}

/**
 * Assemble the read-only context bundle for a PR question (issue #55). PR
 * metadata comes from the job row; the diff, checks, and issue detail come from
 * the forge (each best-effort); feedback and the recent activity log come from
 * the local database. A failed forge call degrades that section to empty rather
 * than aborting, so a question is always answerable from whatever is available.
 */
export async function assembleContext(deps: AssembleContextDeps): Promise<PrQuestionContext> {
  const { job, prNumber, forge, db } = deps;
  const [diff, checks, issue] = await Promise.all([
    safe(() => forge.prDiff(prNumber), ""),
    safe<PrCheck[]>(() => forge.prChecks(prNumber), []),
    safe<IssueDetail | null>(() => forge.viewIssue(job.issueNumber), null),
  ]);

  const checkSummaries: PrCheckSummary[] = checks.map((c) => ({ name: c.name, state: c.state }));
  const feedback = listFeedbackItems(job.id, db).map(
    (f) => `[${f.status}] ${f.reviewer} (${f.classification})${f.detail ? `: ${f.detail}` : ""}`,
  );

  return {
    prNumber,
    branch: job.branch,
    jobStatus: job.status,
    issueNumber: job.issueNumber,
    issueTitle: issue?.title ?? cachedIssueTitle(job, db),
    issueBody: issue?.body ?? "",
    checks: checkSummaries,
    feedback,
    log: recentLog(job.id, db),
    diff,
  };
}

export interface PrQuestionPassDeps {
  questionId: number;
  job: Job;
  prNumber: number;
  question: string;
  forge: QuestionForge;
  db: DB;
  provider: AgentProvider;
  command: string;
  model: string;
  /** Inject a generator (tests); the default runs the agent in a throwaway dir. */
  generate?: PrAnswerGenerator;
  runner?: CommandRunner;
}

/**
 * Answer one stored PR question (issue #55). Assembles the context bundle, asks
 * a read-only agent, and transitions the question to `answered` (storing the
 * redacted reply) or `error` (storing a reason). The default generator runs in
 * a throwaway temp dir with a tight timeout. The whole pass is wrapped so any
 * failure (forge error, empty response, unexpected throw) marks the question as
 * an error and returns — it never throws out.
 */
export async function runPrQuestion(deps: PrQuestionPassDeps): Promise<void> {
  const { questionId, job, prNumber, question, forge, db, provider, command, model } = deps;
  let tmp: string | undefined;
  try {
    const context = await assembleContext({ job, prNumber, forge, db });

    let generate = deps.generate;
    if (!generate) {
      tmp = await mkdtemp(join(tmpdir(), "drydock-pr-question-"));
      generate = buildAnswerGenerator({
        provider,
        command,
        model,
        cwd: tmp,
        runner: deps.runner,
      });
    }

    const answer = await generate({ question, context });
    if (!answer) {
      markQuestionError(questionId, "The agent returned an empty response.", db);
      recordEvent(job.id, "pr_question", { ok: false, questionId }, db);
      return;
    }

    markQuestionAnswered(questionId, redactSecrets(answer), db);
    recordEvent(job.id, "pr_question", { ok: true, questionId }, db);
  } catch (err) {
    if (err instanceof ProviderLimitError) {
      // The agent's quota is exhausted and now latched for other flows to defer
      // on (issue #430). The question must still reach a terminal state
      // (answering → error), but with a reason that tells the asker to retry
      // once the limit resets rather than a raw internal failure.
      markQuestionError(
        questionId,
        `The ${err.info.agent} quota is exhausted; ask again once the limit resets.`,
        db,
      );
      recordEvent(job.id, "pr_question", { ok: false, questionId, reason: "provider limit" }, db);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    markQuestionError(questionId, `Answering failed: ${message}`.slice(0, 500), db);
    recordEvent(job.id, "pr_question", { ok: false, questionId }, db);
  } finally {
    if (tmp) {
      try {
        await rm(tmp, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup; a leftover dir is harmless.
      }
    }
  }
}
