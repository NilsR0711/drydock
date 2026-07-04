"use server";

import { revalidatePath } from "next/cache";
import type { Job } from "@/lib/db/schema";
import { notifyPauseTransition } from "@/lib/notify/lifecycle";
import { getSettings, saveSettings } from "@/lib/settings/service";
import { requeueJobWithEscalation } from "./escalation";
import { getJob, transitionJob } from "./jobs";
import { resumeJobWithInstruction } from "./resume-instruction";
import { abortAllJobs, abortJob } from "./singleton";
import { canTransition, InvalidTransitionError, type JobStatus } from "./state-machine";

/**
 * Put a needs_human (or interrupted) job back in the queue for another
 * attempt. On a repo with escalateModelOnRetry, a failed (needs_human) job's
 * next attempt runs the next-stronger model in the ladder (issue #179).
 */
export async function requeueJobAction(jobId: number) {
  const job = requeueJobWithEscalation(jobId);
  revalidatePath("/needs-human");
  revalidatePath("/");
  revalidatePath(`/repos/${job.repoId}`);
  return job;
}

/**
 * Resume a needs_human job with operator guidance (issue #257): store the typed
 * instruction on the job and requeue it. The next run resumes the stored session
 * with the instruction as the prompt, on the job's preserved branch, so the
 * agent continues its prior work taking the guidance into account.
 */
export async function resumeJobWithInstructionAction(jobId: number, instruction: string) {
  const job = resumeJobWithInstruction(jobId, instruction);
  revalidatePath("/needs-human");
  revalidatePath("/");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/repos/${job.repoId}`);
  return job;
}

/**
 * Abort a single job without revalidating any route. Kills the running agent
 * subprocess first (if one is registered) so it stops spending immediately,
 * then marks the row aborted (issue #89). Aborting a job with no live
 * subprocess (e.g. a needs_human row) just flips the state. Shared by the
 * single-job action and the bulk action so both apply identical semantics.
 */
function abortJobCore(jobId: number): Job {
  abortJob(jobId);
  // abortJob only signals the subprocess; the job may still be settling its own
  // transitions (or may already sit in a terminal state). Only flip to aborted
  // when the state machine allows it from the current status, and tolerate the
  // race where the job settles between the check and the write.
  let job = getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (canTransition(job.status as JobStatus, "aborted")) {
    try {
      job = transitionJob(jobId, "aborted");
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      // The job reached a state with no abort edge (e.g. it merged) in between;
      // report the settled row instead of failing the action.
      job = getJob(jobId) ?? job;
    }
  }
  return job;
}

/**
 * Permanently abort a job that won't be retried. Kills the running agent
 * subprocess first (if one is registered) so it stops spending immediately,
 * then marks the row aborted (issue #89). Aborting a job with no live
 * subprocess (e.g. a needs_human row) just flips the state.
 */
export async function abortJobAction(jobId: number) {
  const job = abortJobCore(jobId);
  revalidatePath("/needs-human");
  revalidatePath("/");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/repos/${job.repoId}`);
  return job;
}

/**
 * Outcome of a bulk job action (issue #410). `succeeded` lists the ids that were
 * acted on, in input order; `failed` pairs each id that threw with its message,
 * so the UI can surface which jobs failed and why instead of swallowing it.
 */
export interface BulkJobActionResult {
  succeeded: number[];
  failed: { id: number; error: string }[];
}

/**
 * Run a per-job operation across a selection, isolating failures: one job that
 * throws never stops the rest (a mass-outage recovery must not be derailed by a
 * single stale row). Revalidates the shared screens plus every affected repo
 * once, after the batch, rather than per job.
 */
function runBulkJobAction(jobIds: number[], op: (jobId: number) => Job): BulkJobActionResult {
  const result: BulkJobActionResult = { succeeded: [], failed: [] };
  const repoIds = new Set<number>();
  for (const jobId of jobIds) {
    try {
      const job = op(jobId);
      result.succeeded.push(jobId);
      repoIds.add(job.repoId);
    } catch (err) {
      result.failed.push({ id: jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.succeeded.length > 0) {
    revalidatePath("/needs-human");
    revalidatePath("/");
    for (const repoId of repoIds) revalidatePath(`/repos/${repoId}`);
  }
  return result;
}

/**
 * Requeue several parked jobs at once (issue #410). Recovers from a systemic
 * event that parked many jobs (expired credentials, a provider-limit
 * misclassification) in one action instead of one click per row. Each job
 * follows the same escalation rules as the single-job requeue.
 */
export async function bulkRequeueJobsAction(jobIds: number[]): Promise<BulkJobActionResult> {
  return runBulkJobAction(jobIds, (jobId) => requeueJobWithEscalation(jobId));
}

/**
 * Abort several jobs at once (issue #410), behind a single confirmation in the
 * UI. Each job is aborted with the same semantics as the single-job action.
 */
export async function bulkAbortJobsAction(jobIds: number[]): Promise<BulkJobActionResult> {
  return runBulkJobAction(jobIds, abortJobCore);
}

/**
 * Emergency stop (issue #89): pause the driver loop so no new jobs start, then
 * terminate every running agent subprocess via the abort registry and mark
 * those jobs aborted. Returns how many in-flight jobs were stopped.
 */
export async function emergencyStopAction() {
  const before = getSettings();
  saveSettings({ paused: true });
  await notifyPauseTransition(before.paused, true);

  const ids = abortAllJobs();
  for (const id of ids) {
    try {
      transitionJob(id, "aborted");
    } catch {
      // The job already settled into a terminal state between the abort signal
      // and this transition; nothing left to stop.
    }
  }

  revalidatePath("/");
  revalidatePath("/needs-human");
  revalidatePath("/settings");
  return { paused: true, aborted: ids.length };
}
