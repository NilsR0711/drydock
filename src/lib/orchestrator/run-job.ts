import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { GhClient } from "@/lib/github/gh";
import { listIssues } from "@/lib/issues/service";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import { ciBabysitter } from "./ci-babysitter";
import {
  type ClaudeSessionResult,
  resumeClaudeSession,
  spawnClaudeSession,
} from "./claude-session";
import { getJob, recordEvent, transitionJob } from "./jobs";

interface WorktreeApi {
  prepare(repo: Repo, jobId: number, issueNumber?: number): Promise<Worktree>;
  commitAndPush(wt: Worktree, message: string): Promise<void>;
  remove(wt: Worktree, repoPath: string): Promise<void>;
}

export interface RunJobDeps {
  db?: DB;
  worktrees?: WorktreeApi;
  runSession?: (job: Job, prompt: string, cwd: string) => Promise<ClaudeSessionResult>;
  createPr?: (input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<number>;
  runBabysitter?: (job: Job, prNumber: number) => Promise<Job>;
}

/**
 * Run one job end-to-end. Worktree is always cleaned up. Any failure before the
 * PR exists routes the job to needs_human with the error recorded.
 */
export async function runJob(jobId: number, deps: RunJobDeps = {}): Promise<Job> {
  const db = deps.db ?? getDb();
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);
  const repo = getRepo(job.repoId, db);
  if (!repo) throw new Error(`repo ${job.repoId} not found`);

  // Claim the job out of "queued" so the rest of the flow operates on a
  // "working" job (the driver loop may already have claimed it; harmless if so).
  if (job.status === "queued") transitionJob(job.id, "working", {}, db);

  const worktrees = deps.worktrees ?? new WorktreeManager();
  const gh = new GhClient(repo.path);
  const runSession =
    deps.runSession ?? ((j, prompt, cwd) => spawnClaudeSession(j, prompt, cwd, { db }));
  const createPr = deps.createPr ?? ((input) => gh.createPr(input));
  const runBabysitter =
    deps.runBabysitter ??
    ((j, prNumber) =>
      ciBabysitter(j, prNumber, {
        gh,
        db,
        resumeSession: (rj, sessionId, failedLog) =>
          resumeClaudeSession(rj, sessionId, failedLog, repo.path, { db }).then(() => undefined),
      }));

  let wt: Worktree | undefined;
  try {
    wt = await worktrees.prepare(repo, job.id, job.issueNumber);
    recordEvent(job.id, "worktree", { path: wt.path, branch: wt.branch }, db);

    const prompt = renderTemplate(resolveTemplateContent(repo.id, TEMPLATE_NAMES.main, db), {
      ISSUE_NUM: job.issueNumber,
      BRANCH: wt.branch,
      REPO_NAME: repo.name,
    });
    const session = await runSession(getJob(job.id, db) as Job, prompt, wt.path);
    if (session.exitCode !== 0) {
      return transitionJob(job.id, "needs_human", { errorMessage: "claude exited non-zero" }, db);
    }

    await worktrees.commitAndPush(wt, `Fix #${job.issueNumber}`);
    const title =
      listIssues(repo.id, db).find((i) => i.number === job.issueNumber)?.title ??
      `Fix #${job.issueNumber}`;
    const prNumber = await createPr({
      head: wt.branch,
      base: repo.defaultBranch,
      title,
      body: `Closes #${job.issueNumber}`,
    });
    transitionJob(job.id, "ci_running", { branch: wt.branch, prNumber }, db);

    return await runBabysitter(getJob(job.id, db) as Job, prNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordEvent(job.id, "error", { message }, db);
    const current = getJob(job.id, db) as Job;
    if (["working", "ci_running", "retrying"].includes(current.status)) {
      return transitionJob(job.id, "needs_human", { errorMessage: message.slice(0, 500) }, db);
    }
    return current;
  } finally {
    if (wt) {
      try {
        await worktrees.remove(wt, repo.path);
      } catch (cleanupErr) {
        console.error(`[run-job] worktree cleanup failed for job ${job.id}`, cleanupErr);
      }
    }
  }
}
