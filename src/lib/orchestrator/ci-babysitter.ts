import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { followupIssues } from "@/lib/db/schema";
import type { ForgeClient, PrCheck } from "@/lib/forge/types";
import { getJob, recordEvent, transitionJob } from "./jobs";

export type CiOutcome = "pending" | "passed" | "failed";

const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const PENDING_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** Reduce a set of PR checks to one outcome (SPEC §6.3). */
export function classifyChecks(checks: PrCheck[]): CiOutcome {
  if (checks.length === 0) return "pending";
  if (checks.some((c) => FAIL_STATES.has(c.state.toUpperCase()))) return "failed";
  if (checks.some((c) => PENDING_STATES.has(c.state.toUpperCase()))) return "pending";
  return "passed";
}

export const MAX_CI_RETRIES = 3;

export interface BabysitterDeps {
  /** Forge client (GitHub or GitLab) for PR/MR checks, merge, and comments. */
  gh: ForgeClient;
  db?: DB;
  /** Resume the Claude session with a CI-fix prompt (Haiku). Returns when done. */
  resumeSession: (job: Job, sessionId: string, failedLog: string) => Promise<void>;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Safety bound for the poll loop in tests. */
  maxPolls?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `gh pr checks` every pollMs. All green → merge (auto). Any red → if under
 * the retry budget, pull the failed log and resume Claude with Haiku, else mark
 * needs_human, comment on the issue, and file a follow-up issue.
 */
export async function ciBabysitter(
  jobArg: Job,
  prNumber: number,
  deps: BabysitterDeps,
): Promise<Job> {
  const db = deps.db ?? getDb();
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 30_000;
  const maxPolls = deps.maxPolls ?? Number.POSITIVE_INFINITY;

  let job = jobArg;
  let polls = 0;
  while (polls < maxPolls) {
    polls++;
    const checks = await deps.gh.prChecks(prNumber);
    const outcome = classifyChecks(checks);

    if (outcome === "pending") {
      await sleep(pollMs);
      continue;
    }

    if (outcome === "passed") {
      await deps.gh.mergePr(prNumber);
      return transitionJob(job.id, "merged", { prNumber }, db);
    }

    // failed
    job = transitionJob(job.id, "ci_failed", { prNumber }, db);
    if (job.ciRetryCount >= MAX_CI_RETRIES) {
      await deps.gh.commentIssue(
        job.issueNumber,
        `CI failed ${MAX_CI_RETRIES} times; handing over to a human.`,
      );
      const followNum = await deps.gh.createIssue(
        `Follow-up: CI keeps failing for issue #${job.issueNumber}`,
        `Job ${job.id} exhausted ${MAX_CI_RETRIES} CI retries on PR #${prNumber}.`,
      );
      db.insert(followupIssues)
        .values({
          jobId: job.id,
          ghIssueNumber: followNum,
          title: `Follow-up for #${job.issueNumber}`,
        })
        .run();
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: "CI failed after max retries" },
        db,
      );
    }

    // Without a recorded session id we cannot resume; resuming with an empty id
    // would start a fresh, context-less session. Hand over to a human instead.
    if (!job.sessionId) {
      recordEvent(job.id, "status", { reason: "missing session id, cannot resume for CI fix" }, db);
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: "CI failed but no session id to resume" },
        db,
      );
    }

    const sessionId = job.sessionId;
    job = transitionJob(job.id, "retrying", { ciRetryCount: job.ciRetryCount + 1 }, db);
    const failedLog = await deps.gh.failedRunLog(prNumber);
    await deps.resumeSession(job, sessionId, failedLog);
    job = transitionJob(job.id, "ci_running", {}, db);
    // loop again to re-poll the now-updated PR
  }

  return getJob(job.id, db) ?? job;
}
