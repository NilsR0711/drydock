import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { IssueSubtask, Job, Repo } from "@/lib/db/schema";
import type { CommandRunner } from "@/lib/exec/runner";
import { upsertMarkerComment } from "@/lib/forge/comment-upsert";
import type { IssueCommentRef } from "@/lib/forge/types";
import type { IssueDetail } from "@/lib/github/gh";
import { listSubtasks, transitionSubtask } from "@/lib/issues/subtasks";
import {
  buildVerificationPrompt,
  parseVerification,
  type VerificationGenerator,
  type VerificationInput,
  type VerificationResult,
} from "@/lib/issues/verify";
import { logError } from "@/lib/log/logger";
import { redactSecrets } from "@/lib/log/redact";
import { recordEvent } from "./jobs";
import { buildOneShotGenerator, type OneShotGeneratorDeps } from "./one-shot-generator";
import type { SubtaskStatus } from "./subtask-state";

/**
 * The driver-side glue for the post-PR verification pass (issue #54): the
 * read-only one-shot agent generator, the best-effort merge of its verdicts
 * back onto subtask status, and the orchestration run-job calls after a PR is
 * opened. Pure prompt/parse logic lives in `issues/verify.ts`. Every step here
 * is best-effort: a failure leaves all state untouched and never throws out, so
 * a bad verification can never corrupt a job or block its merge.
 */

/**
 * Tight wall-clock bound on the verification one-shot (issue #54). This is a
 * read-only review of a bounded diff, not a coding session, so a multi-minute
 * stall means a hung process rather than legitimate work.
 */
export const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;

const COMMENT_HEADER = "🔎 Drydock post-PR verification";

/**
 * Hidden marker keyed by job id so a re-run (a second verification pass for the
 * same job, e.g. after CI healing pushes a new commit) edits the same comment
 * in place instead of stacking a fresh one (idempotency, ADR 019; issue #289).
 */
export function verifyCommentMarker(jobId: number): string {
  return `<!-- drydock:verify:${jobId} -->`;
}

/**
 * A {@link VerificationGenerator} backed by a one-shot agent run. The CLI shape
 * comes from the repo's {@link AgentProvider} (Claude `-p`, Codex `exec`), and a
 * tight timeout is enforced by the runner. Best-effort: a non-zero exit,
 * unparseable output, or a thrown error (e.g. a timeout) all yield `null` —
 * except a waitable provider limit (issues #167/#430), which latches the agent
 * and throws {@link ProviderLimitError} so the caller defers instead of
 * silently recording no verification result against an exhausted quota.
 */
export function buildVerificationGenerator(deps: OneShotGeneratorDeps): VerificationGenerator {
  return buildOneShotGenerator<VerificationInput, VerificationResult | null>(deps, {
    type: "verify",
    defaultTimeoutMs: VERIFY_TIMEOUT_MS,
    buildPrompt: buildVerificationPrompt,
    onResult: (text) => parseVerification(text),
    onExit: () => null,
    onError: () => null,
  });
}

/** Step a subtask forward to `done`, walking the state machine; best-effort. */
function advanceToDone(subtask: IssueSubtask, db: DB): void {
  const status = subtask.status as SubtaskStatus;
  if (status === "done" || status === "skipped") return;
  try {
    if (status === "in_progress") {
      transitionSubtask(subtask.id, "done", db);
      return;
    }
    // pending or deferred: step through in_progress to satisfy the state machine.
    transitionSubtask(subtask.id, "in_progress", db);
    transitionSubtask(subtask.id, "done", db);
  } catch {
    // An invalid transition (e.g. the subtask is already terminal) is ignored:
    // verification never corrupts state.
  }
}

export interface ApplyVerificationResult {
  done: number;
  deferred: number;
  /** Titles of subtasks the verifier judged still unmet (status "pending"). */
  pendingTitles: string[];
}

/**
 * Merge a verification result back onto an issue's subtasks (issue #54).
 * Verdicts are matched to subtasks by ordinal. A `done` verdict advances the
 * subtask to done; a `deferred` verdict marks it deferred; a `pending` verdict
 * leaves the subtask untouched (it cannot be downgraded) but is surfaced so the
 * caller can flag what remains. Every transition is best-effort and an unknown
 * ordinal is ignored — this never throws.
 */
export function applyVerification(
  repoId: number,
  issueNumber: number,
  result: VerificationResult,
  db: DB = getDb(),
): ApplyVerificationResult {
  const subtasks = listSubtasks(repoId, issueNumber, db);
  const byOrdinal = new Map(subtasks.map((s) => [s.ordinal, s]));
  let done = 0;
  let deferred = 0;
  const pendingTitles: string[] = [];

  for (const verdict of result.verdicts) {
    const subtask = byOrdinal.get(verdict.ordinal);
    if (!subtask) continue;
    if (verdict.status === "done") {
      advanceToDone(subtask, db);
      done += 1;
    } else if (verdict.status === "deferred") {
      try {
        transitionSubtask(subtask.id, "deferred", db);
        deferred += 1;
      } catch {
        // already terminal / invalid transition — leave it be.
      }
    } else {
      pendingTitles.push(subtask.title);
    }
  }
  return { done, deferred, pendingTitles };
}

/**
 * Render the issue comment summarising a verification pass. Carries the
 * job-scoped idempotency marker and keeps the thread scannable: the verbose
 * model summary is collapsed behind a `<details>` block, while the actionable
 * pending-subtask list stays inline (issue #289).
 */
function renderComment(
  jobId: number,
  result: VerificationResult,
  applied: ApplyVerificationResult,
): string {
  const lines = [verifyCommentMarker(jobId), "", `${COMMENT_HEADER}`, ""];
  const summary = result.summary.trim();
  if (summary) {
    lines.push(
      "<details><summary>Verification summary</summary>",
      "",
      summary,
      "",
      "</details>",
      "",
    );
  }
  if (applied.pendingTitles.length > 0) {
    lines.push("Subtasks still pending:");
    for (const title of applied.pendingTitles) lines.push(`- ${title}`);
  } else {
    lines.push("All tracked subtasks appear satisfied by the diff.");
  }
  return lines.join("\n");
}

/** The forge operations the verification pass needs; a subset of ForgeClient. */
export interface VerifyForge {
  prDiff(prNumber: number): Promise<string>;
  viewIssue(issueNumber: number): Promise<IssueDetail>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
  /** Optional idempotency seam: list comments to find a prior marker. */
  listIssueComments?(issueNumber: number): Promise<IssueCommentRef[]>;
  /** Optional idempotency seam: edit the prior marker comment in place. */
  updateIssueComment?(issueNumber: number, commentId: string, body: string): Promise<void>;
}

export interface VerificationPassDeps {
  job: Job;
  prNumber: number;
  repo: Repo;
  forge: VerifyForge;
  db: DB;
  provider: AgentProvider;
  command: string;
  model: string;
  /** Inject a generator (tests); the default runs the agent in a throwaway dir. */
  generate?: VerificationGenerator;
  runner?: CommandRunner;
}

/**
 * Run the post-PR verification pass for one opened PR (issue #54). Fetches the
 * PR diff and issue, asks a read-only agent whether the diff satisfies each
 * subtask, merges the verdicts back, and comments a summary on the issue. The
 * default generator runs in a throwaway temp dir with a tight timeout. The whole
 * pass is wrapped so any failure (forge error, empty diff, unparseable output)
 * returns `null` and leaves all state untouched — it never throws and never
 * merges. Callers gate this on the repo's opt-in `verifyPr` flag.
 */
export async function runVerificationPass(
  deps: VerificationPassDeps,
): Promise<VerificationResult | null> {
  const { job, prNumber, repo, forge, db, provider, command, model } = deps;
  let tmp: string | undefined;
  try {
    const diff = await forge.prDiff(prNumber);
    if (!diff.trim()) return null;

    const detail = await forge.viewIssue(job.issueNumber);
    const subtasks = listSubtasks(repo.id, job.issueNumber, db);
    const input: VerificationInput = {
      issueNumber: job.issueNumber,
      issueTitle: detail.title,
      issueBody: detail.body,
      subtasks: subtasks.map((s) => ({ ordinal: s.ordinal, title: s.title })),
      diff,
    };

    let generate = deps.generate;
    if (!generate) {
      tmp = await mkdtemp(join(tmpdir(), "drydock-verify-"));
      generate = buildVerificationGenerator({
        provider,
        command,
        model,
        cwd: tmp,
        repoId: repo.id,
        db,
        runner: deps.runner,
      });
    }

    const result = await generate(input);
    if (!result) {
      recordEvent(job.id, "verification", { ok: false }, db);
      return null;
    }

    const applied = applyVerification(repo.id, job.issueNumber, result, db);
    // The summary mirrors subtask status already updated on the issue, so quiet
    // repos suppress it; the verdicts are still merged above (issue #289).
    if (!repo.quietComments) {
      const body = redactSecrets(renderComment(job.id, result, applied));
      await upsertMarkerComment(
        forge,
        job.issueNumber,
        verifyCommentMarker(job.id),
        body,
        "verify",
      );
    }
    recordEvent(
      job.id,
      "verification",
      {
        ok: true,
        summary: result.summary,
        done: applied.done,
        deferred: applied.deferred,
        pending: applied.pendingTitles.length,
      },
      db,
    );
    return result;
  } catch (err) {
    logError(`[verify] verification pass failed for ${repo.name}#${job.issueNumber}`, err);
    return null;
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
