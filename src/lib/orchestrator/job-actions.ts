"use server";

import { revalidatePath } from "next/cache";
import { notifyPauseTransition } from "@/lib/notify/lifecycle";
import { getSettings, saveSettings } from "@/lib/settings/service";
import { transitionJob } from "./jobs";
import { abortAllJobs, abortJob } from "./singleton";

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
  const job = transitionJob(jobId, "aborted");
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
