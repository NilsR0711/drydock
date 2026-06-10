"use server";

import { revalidatePath } from "next/cache";
import { notifyPauseTransition } from "@/lib/notify/lifecycle";
import { getSettings, saveSettings } from "@/lib/settings/service";
import { getJob, transitionJob } from "./jobs";
import { abortAllJobs, abortJob } from "./singleton";
import { canTransition, InvalidTransitionError, type JobStatus } from "./state-machine";

/** Put a needs_human (or interrupted) job back in the queue for another attempt. */
export async function requeueJobAction(jobId: number) {
  const job = transitionJob(jobId, "queued");
  revalidatePath("/needs-human");
  revalidatePath("/");
  revalidatePath(`/repos/${job.repoId}`);
  return job;
}

/**
 * Permanently abort a job that won't be retried. Kills the running agent
 * subprocess first (if one is registered) so it stops spending immediately,
 * then marks the row aborted (issue #89). Aborting a job with no live
 * subprocess (e.g. a needs_human row) just flips the state.
 */
export async function abortJobAction(jobId: number) {
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
  revalidatePath("/needs-human");
  revalidatePath("/");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/repos/${job.repoId}`);
  return job;
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
