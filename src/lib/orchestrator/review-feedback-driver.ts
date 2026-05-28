import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import { type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { repoAutomation } from "@/lib/repos/automation";
import { commandForAgent } from "./agent-command";
import { spawnAgentSession } from "./agent-session";
import { listJobs } from "./jobs";
import { type FeedbackApplyResult, processPrFeedback, type ReviewForge } from "./review-feedback";

/**
 * Background sweep that drives the PR review-feedback lifecycle (issue #18) for
 * every repo that has opted in. It is intentionally separate from the issue
 * scheduler: feedback arrives after a PR is open, so it iterates jobs that have
 * reached a PR rather than the issue queue. Per-repo and per-job failures are
 * isolated so one bad PR never stalls the sweep.
 */

/** Job states in which a PR is plausibly still open for review. */
const PR_OPEN_STATES = new Set(["ci_running", "ci_failed", "retrying", "needs_human"]);

/** Whether a forge implements the optional review-thread surface (GitHub does). */
function supportsReviewThreads(forge: ForgeClient): forge is ForgeClient & ReviewForge {
  return (
    typeof forge.listReviewThreads === "function" &&
    typeof forge.replyToReviewThread === "function" &&
    typeof forge.updateReviewComment === "function" &&
    typeof forge.resolveReviewThread === "function" &&
    typeof forge.reactToReviewComment === "function"
  );
}

export interface DriveFeedbackDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
  /** Process one job's PR feedback (injectable for tests). */
  processJob?: (repo: Repo, job: Job, forge: ForgeClient) => Promise<void>;
}

export async function driveReviewFeedback(deps: DriveFeedbackDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const processJob = deps.processJob ?? defaultProcessJob;

  for (const repo of listRepos(db)) {
    if (!repoAutomation(repo).autoReviewFeedback) continue;
    try {
      const forge = deps.forgeFor?.(repo) ?? getForge(repo);
      if (!supportsReviewThreads(forge)) continue;

      const candidates = listJobs(repo.id, db).filter(
        (j) => j.prNumber != null && PR_OPEN_STATES.has(j.status),
      );
      for (const job of candidates) {
        try {
          await processJob(repo, job, forge);
        } catch (err) {
          console.error(`[review-feedback] job ${job.id} failed for ${repo.name}`, err);
        }
      }
    } catch (err) {
      console.error(`[review-feedback] sweep failed for ${repo.name}`, err);
    }
  }
}

/** Build the prompt that asks the agent to address a single review comment. */
function feedbackPrompt(thread: ReviewThread): string {
  const first = thread.comments[0];
  const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "this PR";
  return [
    `A reviewer left this comment on ${where} of the current pull request:`,
    "",
    (first?.body ?? "").trim(),
    "",
    "Make only the change this comment asks for. Do not address anything else.",
    "When done, ensure the working tree builds and tests pass, then stop — the",
    "commit and push are handled for you.",
  ].join("\n");
}

/** The worktree operations the agent-apply step needs (injectable for tests). */
export interface FeedbackWorktrees {
  prepareForBranch(repo: Repo, branch: string, key: string): Promise<Worktree>;
  commitAndPush(wt: Worktree, message: string): Promise<void>;
  remove(wt: Worktree, repoPath: string): Promise<void>;
}

export interface AgentApplyDeps {
  repo: Repo;
  job: Job;
  worktrees: FeedbackWorktrees;
  runSession: (job: Job, prompt: string, cwd: string) => Promise<{ exitCode: number }>;
}

/**
 * Build the `applyFeedback` callback for one job: it checks out the PR branch in
 * an isolated worktree, runs the agent against the single review comment,
 * commits and pushes, and tears the worktree down. A non-zero agent exit or an
 * empty commit (nothing staged) reports failure so the lifecycle can retry or
 * flag for a human. Never merges the PR.
 */
export function buildAgentApply(
  deps: AgentApplyDeps,
): (item: unknown, thread: ReviewThread) => Promise<FeedbackApplyResult> {
  return async (_item, thread) => {
    if (!deps.job.branch) return { ok: false, detail: "job has no branch" };
    const wt = await deps.worktrees.prepareForBranch(
      deps.repo,
      deps.job.branch,
      `${deps.job.id}-${thread.id}`,
    );
    try {
      const session = await deps.runSession(deps.job, feedbackPrompt(thread), wt.path);
      if (session.exitCode !== 0) return { ok: false, detail: "agent exited non-zero" };
      try {
        await deps.worktrees.commitAndPush(wt, `Address review feedback on ${thread.path ?? "PR"}`);
      } catch {
        return { ok: false, detail: "no change produced" };
      }
      return { ok: true };
    } finally {
      try {
        await deps.worktrees.remove(wt, deps.repo.path);
      } catch (err) {
        console.error(`[review-feedback] worktree cleanup failed for job ${deps.job.id}`, err);
      }
    }
  };
}

/** Production composition: real forge, worktree, and agent session. */
async function defaultProcessJob(repo: Repo, job: Job, forge: ForgeClient): Promise<void> {
  if (!supportsReviewThreads(forge) || job.prNumber == null) return;
  const db = getDb();
  const cfg = repoAutomation(repo);
  const provider = getAgentProvider(job.agent);
  const command = commandForAgent(provider, db);
  const worktrees = new WorktreeManager();

  const applyFeedback = buildAgentApply({
    repo,
    job,
    worktrees,
    runSession: (j, prompt, cwd) =>
      spawnAgentSession(j, prompt, cwd, { db, provider, command }).then((r) => ({
        exitCode: r.exitCode,
      })),
  });

  await processPrFeedback(job.id, job.prNumber, {
    forge,
    db,
    gate: { trustedReviewers: cfg.trustedReviewers, ignoredBots: cfg.ignoredBots },
    includeProgressReplies: cfg.includeProgressReplies,
    applyFeedback,
  });
}
