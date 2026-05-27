import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { recordEvent, transitionJob } from "./jobs";

export interface SessionDeps {
  runner?: CommandRunner;
  db?: DB;
  /** Mock CI outcome for Phase 2 (no real PR yet). Real babysitter arrives in Phase 5. */
  ciPasses?: boolean;
}

/**
 * Phase 2 mock lifecycle: drive a job through working -> ci_running -> merged
 * (or needs_human on failure). Replaced by the real stream parser / CI
 * babysitter in later phases. The runner is injectable (ADR 004).
 */
export async function runMockSession(
  job: Job,
  command: string,
  args: string[],
  cwd: string,
  deps: SessionDeps = {},
): Promise<Job> {
  const db = deps.db ?? getDb();
  const runner = deps.runner ?? spawnRunner;

  transitionJob(job.id, "working", { model: job.model }, db);
  const res = await runner(command, args, cwd);
  recordEvent(job.id, "claude_exit", { exitCode: res.exitCode }, db);

  if (res.exitCode !== 0) {
    return transitionJob(
      job.id,
      "needs_human",
      { errorMessage: res.stderr.slice(0, 500) || "claude exited non-zero" },
      db,
    );
  }

  transitionJob(job.id, "ci_running", {}, db);
  if (deps.ciPasses === false) {
    transitionJob(job.id, "ci_failed", {}, db);
    return transitionJob(job.id, "needs_human", { errorMessage: "CI failed" }, db);
  }
  return transitionJob(job.id, "merged", {}, db);
}
