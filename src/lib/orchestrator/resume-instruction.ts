import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { getJob, recordEvent, transitionJob } from "./jobs";

/**
 * Unblock a `needs_human` job with operator guidance (issue #257). The human
 * reads the issue + the run log and types how to proceed; this stores that text
 * on the job and requeues it. On the next run, run-job resumes the stored
 * session (`--resume`) with the instruction as the prompt — on the job's
 * preserved branch when one was pushed at park time — so the agent continues
 * its prior work with the guidance instead of retrying the same failed context.
 *
 * Only `needs_human` jobs are eligible: an `interrupted` job is a crash to retry
 * as-is, and a `waiting_limit` job resumes itself automatically. The instruction
 * is recorded as a job event so the log shows exactly what was asked.
 *
 * Shared by the server action and the MCP tool, so it must stay free of Next.js
 * imports (the MCP server runs in its own process).
 */
export function resumeJobWithInstruction(
  jobId: number,
  instruction: string,
  db: DB = getDb(),
): Job {
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);

  const trimmed = instruction.trim();
  if (!trimmed) throw new Error("instruction must not be empty");

  if (job.status !== "needs_human") {
    throw new Error(`job ${jobId} is ${job.status}, not needs_human — cannot resume with guidance`);
  }

  // Record the guidance before the status flip so the log reads chronologically:
  // the human's instruction, then the job re-entering the queue.
  recordEvent(jobId, "human_instruction", { instruction: trimmed }, db);
  return transitionJob(jobId, "queued", { humanInstruction: trimmed }, db);
}
