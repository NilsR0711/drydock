import { listAdrs } from "@/lib/adr/service";
import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import { EmptyCommitError, type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { listIssues } from "@/lib/issues/service";
import { listSubtasks } from "@/lib/issues/subtasks";
import type { NotificationEvent } from "@/lib/notify/events";
import { dispatch } from "@/lib/notify/notifier";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import { getSettings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import { type AgentSessionResult, resumeAgentSession, spawnAgentSession } from "./agent-session";
import { ciBabysitter } from "./ci-babysitter";
import { getJob, recordEvent, transitionJob } from "./jobs";
import { markSubtasksDone, markSubtasksWorking, subtaskPromptSection } from "./subtask-driver";
import type { SubtaskStatus } from "./subtask-state";

interface WorktreeApi {
  prepare(repo: Repo, jobId: number, issueNumber?: number): Promise<Worktree>;
  commitAndPush(wt: Worktree, message: string): Promise<void>;
  remove(wt: Worktree, repoPath: string): Promise<void>;
}

export interface RunJobDeps {
  db?: DB;
  worktrees?: WorktreeApi;
  runSession?: (job: Job, prompt: string, cwd: string) => Promise<AgentSessionResult>;
  createPr?: (input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<number>;
  runBabysitter?: (job: Job, prNumber: number) => Promise<Job>;
  notify?: NotifyEvent;
}

/** Event-aware notification sink: routes a lifecycle event + message downstream. */
type NotifyEvent = (event: NotificationEvent, text: string) => Promise<void>;

/**
 * Run one job end-to-end and notify on its lifecycle. Worktree cleanup and
 * state transitions live in runJobCore; this wrapper plus the PR-opened hook
 * inside core fan each event out to the configured channels (issue #22).
 */
export async function runJob(jobId: number, deps: RunJobDeps = {}): Promise<Job> {
  const db = deps.db ?? getDb();
  const send: NotifyEvent = deps.notify ?? ((event, text) => dispatch(event, text, db));
  const result = await runJobCore(jobId, deps, send);
  if (result.status === "merged") {
    await send(
      "pr_merged",
      `✅ Merged: ${result.repoId}#${result.issueNumber} (PR #${result.prNumber}).`,
    );
  } else if (result.status === "needs_human") {
    await send(
      "needs_human",
      `⚠️ Needs human: ${result.repoId}#${result.issueNumber} — ${result.errorMessage ?? "review required"}.`,
    );
  } else if (result.status === "aborted") {
    await send(
      "job_failed",
      `🛑 Aborted: ${result.repoId}#${result.issueNumber} — ${result.errorMessage ?? "job aborted"}.`,
    );
  }
  return result;
}

async function runJobCore(jobId: number, deps: RunJobDeps, send: NotifyEvent): Promise<Job> {
  const db = deps.db ?? getDb();
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);
  const repo = getRepo(job.repoId, db);
  if (!repo) throw new Error(`repo ${job.repoId} not found`);

  // Claim the job out of "queued" so the rest of the flow operates on a
  // "working" job (the driver loop may already have claimed it; harmless if so).
  if (job.status === "queued") transitionJob(job.id, "working", {}, db);

  const worktrees = deps.worktrees ?? new WorktreeManager();
  const forge = getForge(repo);
  const provider = getAgentProvider(job.agent);
  const command = commandForAgent(provider, db);
  // Wall-clock session bound (issue #47): a per-repo override wins, else the
  // global default. Guarantees a hung agent is aborted and the slot freed.
  const settings = getSettings(db);
  const maxJobMinutes = repo.maxJobMinutes ?? settings.maxJobMinutes;
  const timeoutMs = maxJobMinutes * 60_000;
  // Wall-clock CI wait budget (issue #52): a per-repo override wins, else the
  // global default. Bounds the babysitter so a never-settling PR escalates to a
  // human instead of looping forever.
  const ciWaitMs = (repo.maxCiWaitMinutes ?? settings.maxCiWaitMinutes) * 60_000;
  const runSession =
    deps.runSession ??
    ((j, prompt, cwd) => spawnAgentSession(j, prompt, cwd, { db, provider, command, timeoutMs }));
  const createPr = deps.createPr ?? ((input) => forge.createPr(input));
  const runBabysitter =
    deps.runBabysitter ??
    ((j, prNumber) =>
      ciBabysitter(j, prNumber, {
        gh: forge,
        db,
        ciWaitMs,
        resumeSession: (rj, sessionId, failedLog) =>
          resumeAgentSession(rj, sessionId, failedLog, repo.path, {
            db,
            provider,
            command,
            timeoutMs,
          }).then(() => undefined),
        // Opt-in structured CI auto-healing (issue #16, ADR 017).
        autoHeal: repo.autoHealCi
          ? { headSha: (pr) => forge.prHeadSha(pr), provider: repo.platform }
          : undefined,
      }));

  let wt: Worktree | undefined;
  try {
    wt = await worktrees.prepare(repo, job.id, job.issueNumber);
    recordEvent(job.id, "worktree", { path: wt.path, branch: wt.branch }, db);

    let prompt = renderTemplate(resolveTemplateContent(repo.id, TEMPLATE_NAMES.main, db), {
      ISSUE_NUM: job.issueNumber,
      BRANCH: wt.branch,
      REPO_NAME: repo.name,
    });

    // Decomposed issues (issue #19, opt-in): surface the ordered subtasks in the
    // prompt and mark them in progress so the UI reflects work starting. The
    // subtasks were prepared by the decomposition sweep; here we only consume
    // them, leaving non-decomposed issues entirely unaffected.
    if (repo.autoDecompose) {
      const subtasks = listSubtasks(repo.id, job.issueNumber, db);
      if (subtasks.length > 0) {
        prompt += subtaskPromptSection(
          subtasks.map((s) => ({ title: s.title, status: s.status as SubtaskStatus })),
        );
        markSubtasksWorking(repo.id, job.issueNumber, db);
      }
    }

    const session = await runSession(getJob(job.id, db) as Job, prompt, wt.path);
    if (session.timedOut) {
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: `${provider.label} timed out after ${maxJobMinutes} minutes` },
        db,
      );
    }
    if (session.exitCode !== 0) {
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: `${provider.label} exited non-zero` },
        db,
      );
    }

    // Per-repo ADR gate: hold the merge while ADRs await review (SPEC opt-in).
    if (repo.adrGating) {
      const pending = listAdrs("pending_review", db, repo.id);
      if (pending.length > 0) {
        return transitionJob(
          job.id,
          "needs_human",
          { errorMessage: `Blocked by ${pending.length} pending ADR review(s).` },
          db,
        );
      }
    }

    try {
      await worktrees.commitAndPush(wt, `Fix #${job.issueNumber}`);
    } catch (err) {
      // A legitimate no-op run (the issue needed no code change) produces an
      // empty commit. Report it as a clear outcome rather than a raw git error
      // (issue #50). Any other failure (e.g. a rejected push) still propagates.
      if (err instanceof EmptyCommitError) {
        return transitionJob(
          job.id,
          "needs_human",
          { errorMessage: "Agent produced no changes" },
          db,
        );
      }
      throw err;
    }
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
    await send("pr_opened", `🔀 PR opened: ${repo.id}#${job.issueNumber} (PR #${prNumber}).`);

    const final = await runBabysitter(getJob(job.id, db) as Job, prNumber);
    // A merged job lands the whole decomposed issue: mark every subtask done.
    if (repo.autoDecompose && final.status === "merged") {
      markSubtasksDone(repo.id, job.issueNumber, db);
    }
    return final;
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
