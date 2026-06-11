import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Job } from "@/lib/db/schema";
import { nextStrongerModel } from "@/lib/models";
import { getJob, recordEvent, transitionJob } from "./jobs";

/**
 * Requeue a parked job, escalating its model one rung up the agent's ladder
 * when the repo opted in (issue #179). Escalation applies only to jobs coming
 * out of `needs_human` — a failed attempt being retried. An `interrupted` job
 * (process crash) is not a failure of the model, and a `waiting_limit` job
 * resumes its stored session, where a mid-session model swap would be wrong.
 *
 * The escalated model is persisted on the job row itself, so run-job picks it
 * up (`job.model ?? repo.defaultModel`) and cost accounting prices the attempt
 * at the model that actually ran. Capped at the strongest model: at the top of
 * the ladder the job simply requeues unchanged.
 *
 * Shared by the server action and the MCP tool, so it must stay free of
 * Next.js imports (the MCP server runs in its own process).
 */
export function requeueJobWithEscalation(jobId: number, db: DB = getDb()): Job {
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);

  let escalateTo: string | null = null;
  if (job.status === "needs_human") {
    const repo = getRepo(job.repoId, db);
    if (repo?.escalateModelOnRetry) {
      escalateTo = nextStrongerModel(job.agent as AgentId, job.model);
    }
  }

  const requeued = transitionJob(jobId, "queued", escalateTo ? { model: escalateTo } : {}, db);
  if (escalateTo) {
    recordEvent(jobId, "status", { reason: `model_escalated: ${job.model} → ${escalateTo}` }, db);
  }
  return requeued;
}
