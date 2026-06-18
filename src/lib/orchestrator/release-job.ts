import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import { getRepo } from "@/lib/db/queries";
import type { Worktree } from "@/lib/git/worktree";
import { WorktreeManager } from "@/lib/git/worktree";
import { logError } from "@/lib/log/logger";
import type { NotificationEvent } from "@/lib/notify/events";
import { dispatch } from "@/lib/notify/notifier";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import {
  createReleaseRun,
  findReleaseRunByJob,
  publishAgentReleaseRun,
  transitionReleaseRun,
} from "@/lib/release/release-service";
import type { ReleaseStatus } from "@/lib/release/release-state";
import { getSettings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import { type AgentSessionResult, spawnAgentSession } from "./agent-session";
import { getJob, recordEvent, transitionJob } from "./jobs";
import { clearProviderLimit } from "./provider-limit";
import { consumeQuestions as defaultConsumeQuestions } from "./questions-metadata";
import { consumeReleaseMetadata as defaultConsumeReleaseMetadata } from "./release-metadata";

/** The worktree operations a release job needs (no commit/push — the agent pushes itself). */
interface ReleaseWorktreeApi {
  prepare(repo: Repo, jobId: number, issueNumber?: number, label?: string): Promise<Worktree>;
  remove(wt: Worktree, repoPath: string): Promise<void>;
}

/** Event-aware notification sink, matching run-job's. */
type NotifyEvent = (event: NotificationEvent, text: string) => Promise<void>;

export interface RunReleaseJobDeps {
  db?: DB;
  worktrees?: ReleaseWorktreeApi;
  /**
   * Run the release agent session. The fourth argument is the bypass-permissions
   * flag (always true here — the agent must run the repo's release commands).
   * Injectable for tests; defaults to a full-shell-access spawnAgentSession.
   */
  runSession?: (
    job: Job,
    prompt: string,
    cwd: string,
    bypassPermissions: boolean,
  ) => Promise<AgentSessionResult>;
  /** Read+remove `.drydock/QUESTIONS.md`; injectable for tests. */
  consumeQuestions?: (worktreePath: string) => string | null;
  /** Read+remove `.drydock/RELEASE.md`; injectable for tests. */
  consumeReleaseMetadata?: (worktreePath: string) => {
    tag: string | null;
    title: string;
    notes: string;
  } | null;
}

/**
 * Run an agent-driven release job end-to-end (issue #256). Unlike the
 * issue-implementation flow, the agent performs the release itself — it runs
 * with full shell access and triggers/commits/pushes the repo's actual release
 * mechanism — so this runner opens no PR, runs no CI babysitter, and never
 * commits the worktree (whatever the agent did not push is discarded with the
 * throwaway checkout). The run is recorded in `release_runs` (mode "agent") for
 * the panel, and the agent's steps stream to the job log via spawnAgentSession.
 *
 * Outcomes mirror run-job's escalation policy: a timeout / cost-cap / spawn /
 * provider-limit / non-zero exit, or an agent that parked open questions in
 * `.drydock/QUESTIONS.md`, lands the job in `needs_human` (a release is hard to
 * reverse, so an uncertain run is parked, never retried unattended). A clean run
 * settles the job `released` and the run `published`.
 */
export async function runReleaseJob(
  jobId: number,
  deps: RunReleaseJobDeps = {},
  send: NotifyEvent = (event, text) => dispatch(event, text, deps.db ?? getDb()),
): Promise<Job> {
  const db = deps.db ?? getDb();
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);
  const repo = getRepo(job.repoId, db);
  if (!repo) throw new Error(`repo ${job.repoId} not found`);

  // The run is normally created by the start action; recreate defensively so a
  // direct/recovered run is still recorded in the panel.
  const run = findReleaseRunByJob(jobId, db) ?? createReleaseRun({ repoId: repo.id, mode: "agent", jobId }, db);

  if (job.status === "queued") transitionJob(job.id, "working", {}, db);

  const worktrees = deps.worktrees ?? new WorktreeManager();
  const provider = getAgentProvider(job.agent);
  const command = commandForAgent(provider, db);
  const settings = getSettings(db);
  const maxJobMinutes = repo.maxJobMinutes ?? settings.maxJobMinutes;
  const timeoutMs = maxJobMinutes * 60_000;
  const maxJobCostUsd = repo.maxJobCostUsd ?? settings.maxJobCostUsd;

  const runSession =
    deps.runSession ??
    ((j, prompt, cwd, bypassPermissions) =>
      spawnAgentSession(j, prompt, cwd, {
        db,
        provider,
        command,
        timeoutMs,
        costCapUsd: maxJobCostUsd,
        bypassPermissions,
      }));
  const consumeQuestions = deps.consumeQuestions ?? defaultConsumeQuestions;
  const consumeReleaseMetadata = deps.consumeReleaseMetadata ?? defaultConsumeReleaseMetadata;

  // Move the run into the in-flight lane (idempotent across a recovered re-run).
  if (run.status === "detected") transitionReleaseRun(run.id, "evaluating", {}, db);

  /** Settle the run as failed/parked, tolerating a run already past the active lane. */
  const failRun = (message: string): void => {
    const current = findReleaseRunByJob(jobId, db);
    const status = (current?.status ?? "evaluating") as ReleaseStatus;
    if (status === "evaluating" || status === "proposed" || status === "publishing") {
      transitionReleaseRun(run.id, "error", { errorMessage: message.slice(0, 500) }, db);
    }
  };

  let wt: Worktree | undefined;
  try {
    wt = await worktrees.prepare(repo, job.id, 0, "release");
    recordEvent(job.id, "worktree", { path: wt.path, branch: wt.branch }, db);

    const prompt = renderTemplate(resolveTemplateContent(repo.id, TEMPLATE_NAMES.release, db), {
      REPO_NAME: repo.name,
      BRANCH: wt.branch,
      DEFAULT_BRANCH: repo.defaultBranch,
    });

    const session = await runSession(getJob(job.id, db) as Job, prompt, wt.path, true);

    // An out-of-band abort (abort action, emergency stop) wins: never settle a
    // job that was killed mid-session. Its run is left in `evaluating` so a
    // requeue can re-run cleanly.
    const after = getJob(job.id, db) as Job;
    if (after.status === "aborted" || after.status === "interrupted") return after;

    // Map every failure to needs_human with a clear reason. A provider limit is
    // deliberately NOT auto-waited here: re-running a partly-done release
    // unattended could double-cut it, so an operator decides.
    const failure = sessionFailureReason(session, {
      provider: provider.label,
      maxJobMinutes,
      maxJobCostUsd,
      command,
    });
    if (failure) {
      failRun(failure);
      return transitionJob(job.id, "needs_human", { errorMessage: failure.slice(0, 500) }, db);
    }

    // A clean session ends any provider-limit streak (issues #166/#167).
    clearProviderLimit(provider.id, db);

    // The agent parked a decision only a human can make (issue #251): record the
    // questions in the job log and hand off. There is no issue to comment on, so
    // the log + needs_human status carry the handoff.
    const questions = consumeQuestions(wt.path);
    if (questions) {
      recordEvent(job.id, "status", { reason: "agent has open questions", questions }, db);
      failRun("agent parked open questions for a human");
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: "agent has open questions", branch: wt.branch },
        db,
      );
    }

    // Success: record whatever the agent reported and settle both rows.
    const meta = consumeReleaseMetadata(wt.path);
    publishAgentReleaseRun(
      run.id,
      { tag: meta?.tag ?? null, title: meta?.title ?? null, notes: meta?.notes ?? null },
      db,
    );
    const released = transitionJob(job.id, "released", { branch: wt.branch }, db);
    await send(
      "release_published",
      `🚀 Release done: ${repo.name}${meta?.tag ? ` (${meta.tag})` : ""}.`,
    );
    return released;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordEvent(job.id, "error", { message }, db);
    failRun(message);
    const current = getJob(job.id, db) as Job;
    if (current.status === "working") {
      return transitionJob(job.id, "needs_human", { errorMessage: message.slice(0, 500) }, db);
    }
    return current;
  } finally {
    if (wt) {
      try {
        await worktrees.remove(wt, repo.path);
      } catch (cleanupErr) {
        logError(`[release-job] worktree cleanup failed for job ${job.id}`, cleanupErr);
      }
    }
  }
}

/**
 * Map a finished session to a human-readable failure reason, or undefined when
 * it succeeded. Mirrors run-job's escalation ordering (timeout → cost → spawn →
 * limit → non-zero exit) but collapses every case to a single needs-human
 * message — a release never auto-retries.
 */
function sessionFailureReason(
  session: AgentSessionResult,
  ctx: { provider: string; maxJobMinutes: number; maxJobCostUsd: number; command: string },
): string | undefined {
  if (session.timedOut) return `${ctx.provider} timed out after ${ctx.maxJobMinutes} minutes`;
  if (session.costExceeded) return `per-job cost limit of $${ctx.maxJobCostUsd} reached`;
  if (session.spawnError) return `failed to start ${ctx.command}: ${session.spawnError.message}`;
  if (session.limit) {
    return `${ctx.provider} unavailable (${session.limit.kind}): ${session.limit.rawSnippet ?? "limit reached"}`;
  }
  if (session.exitCode !== 0) return `${ctx.provider} exited non-zero`;
  return undefined;
}
