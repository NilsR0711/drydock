"use server";

import { revalidatePath } from "next/cache";
import { transitionJob } from "./jobs";

/** Put a needs_human (or interrupted) job back in the queue for another attempt. */
export async function requeueJobAction(jobId: number) {
  const job = transitionJob(jobId, "queued");
  revalidatePath("/needs-human");
  revalidatePath("/");
  revalidatePath(`/repos/${job.repoId}`);
  return job;
}

/** Permanently abort a job that won't be retried. */
export async function abortJobAction(jobId: number) {
  const job = transitionJob(jobId, "aborted");
  revalidatePath("/needs-human");
  revalidatePath("/");
  revalidatePath(`/repos/${job.repoId}`);
  return job;
}
