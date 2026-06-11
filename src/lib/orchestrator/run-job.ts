import { eq } from "drizzle-orm";
import { listAdrs } from "@/lib/adr/service";
import { getAgentProvider } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { jobs } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import { EmptyCommitError, type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { listIssues } from "@/lib/issues/service";
import { listSubtasks } from "@/lib/issues/subtasks";
import { logError } from "@/lib/log/logger";
import type { NotificationEvent } from "@/lib/notify/events";
import { dispatch } from "@/lib/notify/notifier";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import { agentInstructionsPromptSection } from "@/lib/repos/agent-instructions";
import { getSettings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import {
  type AgentSessionResult,
  resumeAgentSession,
  type SessionLimitInfo,
  spawnAgentSession,
} from "./agent-session";
import { ciBabysitter, type ResumeOutcome, resumeFailureReason } from "./ci-babysitter";
import { getJob, recordEvent, transitionJob } from "./jobs";
import { runOneShotAndRecordCost } from "./one-shot-runner";
import { clearProviderLimit, latchProviderLimit, limitAutoWaitEnabled } from "./provider-limit";
import { InvalidTransitionError } from "./state-machine";
import {
  markSubtasksDone,
  markSubtasksParked,
  markSubtasksWorking,
  subtaskPromptSection,
} from "./subtask-driver";
import type { SubtaskStatus } from "./subtask-state";
import { runVerificationPass } from "./verify-driver";

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
  verify?: (job: Job, prNumber: number) => Promise<void>;
  notify?: NotifyEvent;
  /** Run the read-only plan stage (issue #160); injectable for tests. */
  runPlan?: (job: Job, prompt: string, cwd: string) => Promise<{ text: string; exitCode: number }>;
  /** Post a comment on the job's issue; injectable for tests. */
  commentIssue?: (issueNumber: number, body: string) => Promise<void>;
  /**
   * Resume the stored session of a limit-parked job (issue #166); injectable
   * for tests. Defaults to resumeAgentSession on the job's own model.
   */
  resumeLimitSession?: (job: Job, prompt: string, cwd: string) => Promise<AgentSessionResult>;
}

/** Keeps an unexpectedly verbose plan from flooding the work prompt. */
const PLAN_MAX_CHARS = 10_000;

/** Render the plan as a dedicated, length-capped prompt section (issue #160). */
export function planPromptSection(plan: string): string {
  const trimmed = plan.trim();
  if (!trimmed) return "";
  const capped =
    trimmed.length > PLAN_MAX_CHARS
      ? `${trimmed.slice(0, PLAN_MAX_CHARS)}\n… (truncated)`
      : trimmed;
  return [
    "",
    "",
    "## Implementation plan",
    "Follow this plan unless the code contradicts it:",
    "",
    capped,
  ].join("\n");
}

/** Event-aware notification sink: routes a lifecycle event + message downstream. */
type NotifyEvent = (event: NotificationEvent, text: string) => Promise<void>;

/** Operator-facing description of a parked job's limit kind (issues #166/#167). */
export function limitParkMessage(kind: SessionLimitInfo["kind"], agent: AgentId): string {
  const [vendor, label] = agent === "codex" ? ["OpenAI", "Codex"] : ["Anthropic", "Claude"];
  switch (kind) {
    case "rate_limit":
      return `${vendor} API rate limit hit — waiting for the window to clear`;
    case "overloaded":
      return `${vendor} API overloaded — waiting before retrying`;
    default:
      return `${label} usage limit reached — waiting for the quota to reset`;
  }
}

/**
 * Build the babysitter's CI-fix resume callback. The fix session must run in
 * the job's worktree — the PR branch is checked out there, not in the
 * operator's primary checkout — and its result must be committed and pushed,
 * or the PR head never changes and the babysitter burns its whole retry
 * budget re-observing the same failed checks. Exported for tests.
 */
export function buildCiFixResume(opts: {
  worktrees: Pick<WorktreeApi, "commitAndPush">;
  /** Resolves the job's live worktree; the babysitter only runs while it exists. */
  worktree: () => Worktree | undefined;
  /** Whether an outside actor (abort, emergency stop) settled the job. */
  settled?: () => boolean;
  resume: (
    job: Job,
    sessionId: string,
    failedLog: string,
    cwd: string,
  ) => Promise<AgentSessionResult>;
}): (job: Job, sessionId: string, failedLog: string) => Promise<ResumeOutcome> {
  return async (job, sessionId, failedLog) => {
    const wt = opts.worktree();
    if (!wt) throw new Error(`job ${job.id} has no live worktree to resume in`);
    const result = await opts.resume(job, sessionId, failedLog, wt.path);
    const outcome: ResumeOutcome = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      costExceeded: result.costExceeded,
      spawnError: result.spawnError,
      limit: result.limit,
    };
    if (resumeFailureReason(outcome)) return outcome;
    // An abort that landed while the fix session ran must win: never push an
    // aborted job's partial work. The babysitter escalates on the reason; for
    // an already-settled job its transition throws and runJobCore's catch
    // returns the settled row untouched.
    if (opts.settled?.()) return { ...outcome, settledExternally: true };
    try {
      await opts.worktrees.commitAndPush(wt, `Fix CI for #${job.issueNumber}`);
    } catch (err) {
      // A fix session that changed nothing cannot turn CI green; report it so
      // the babysitter escalates instead of polling an unchanged PR head.
      if (err instanceof EmptyCommitError) return { ...outcome, noChanges: true };
      throw err;
    }
    return outcome;
  };
}

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
  // Per-job cost ceiling (issue #57): a per-repo override wins, else the global
  // default. 0 disables it. Bounds the blast radius of one runaway session so a
  // single long loop cannot drain the whole daily budget by itself.
  const maxJobCostUsd = repo.maxJobCostUsd ?? settings.maxJobCostUsd;
  const runSession =
    deps.runSession ??
    ((j, prompt, cwd) =>
      spawnAgentSession(j, prompt, cwd, {
        db,
        provider,
        command,
        timeoutMs,
        costCapUsd: maxJobCostUsd,
      }));
  const createPr = deps.createPr ?? ((input) => forge.createPr(input));
  // Plan stage runner (issue #160): a read-only, cost-tracked one-shot in the
  // worktree. Reuses the model the implementation session will run on.
  const runPlan =
    deps.runPlan ??
    ((j: Job, prompt: string, cwd: string) =>
      runOneShotAndRecordCost({
        provider,
        command,
        model: j.model ?? repo.defaultModel,
        cwd,
        prompt,
        repoId: repo.id,
        type: "plan",
        timeoutMs,
        db,
      }).then((r) => ({ text: r.text, exitCode: r.exitCode })));
  const commentIssue =
    deps.commentIssue ??
    ((issueNumber: number, body: string) => forge.commentIssue(issueNumber, body));
  // Limit-resume runner (issue #166): continues a limit-parked job's stored
  // session on the job's own model and turn budget — this is the main work
  // resuming, not a cheap CI fix.
  const resumeLimitSession =
    deps.resumeLimitSession ??
    ((j: Job, prompt: string, cwd: string) => {
      // The limit-resume branch only fires with a recorded session id; guard
      // anyway so a concurrently cleared row fails loudly instead of passing
      // null into the CLI's --resume flag.
      if (!j.sessionId) throw new Error(`job ${j.id} has no session id to resume after a limit`);
      return resumeAgentSession(j, j.sessionId, "", cwd, {
        db,
        provider,
        command,
        timeoutMs,
        costCapUsd: maxJobCostUsd,
        resumePrompt: prompt,
        resumeModel: j.model ?? repo.defaultModel,
        resumeMaxTurns: j.maxTurns,
      });
    });

  /**
   * Park the job on a transient provider limit (issue #166): latch the
   * provider globally (unless this was already a latch bounce), record the
   * explicit reason, flip to waiting_limit with the resume marker, and leave a
   * best-effort breadcrumb on the issue. The driver requeues the job once the
   * window clears.
   */
  const parkOnLimit = async (limit: SessionLimitInfo): Promise<Job> => {
    const blockedUntil = limit.latched
      ? (limit.resetAt ?? Math.floor(Date.now() / 1000) + 60)
      : latchProviderLimit(limit, db).latch.blockedUntil;
    recordEvent(
      job.id,
      "status",
      { reason: `${limit.agent}_${limit.kind}`, blockedUntil, snippet: limit.rawSnippet },
      db,
    );
    if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
    const parked = transitionJob(
      job.id,
      "waiting_limit",
      {
        errorMessage: limitParkMessage(limit.kind, limit.agent),
        availableAt: blockedUntil,
        limitKind: limit.kind,
      },
      db,
    );
    try {
      const resumesAt = new Date(blockedUntil * 1000).toISOString().slice(0, 16).replace("T", " ");
      await commentIssue(
        job.issueNumber,
        `⏳ Drydock paused this job: ${limitParkMessage(limit.kind, limit.agent)}. It will retry automatically (next attempt around ${resumesAt} UTC).`,
      );
    } catch (err) {
      logError(`[run-job] limit-park comment failed for job ${job.id}`, err);
    }
    return parked;
  };
  // Declared before the babysitter deps so the CI-fix resume closure can read
  // the worktree created below; it stays alive for the whole babysitter call.
  let wt: Worktree | undefined;
  const runBabysitter =
    deps.runBabysitter ??
    ((j, prNumber) =>
      ciBabysitter(j, prNumber, {
        gh: forge,
        db,
        ciWaitMs,
        // Review settle gate (issue #159): hold the merge after CI goes green
        // so late bot/human reviews can land first. 0 merges immediately.
        mergeGateMs: repo.mergeGateMinutes * 60_000,
        // CI fixes run in the job's worktree and are committed + pushed there;
        // resuming in repo.path edited the operator's checkout and could never
        // move the PR head.
        resumeSession: buildCiFixResume({
          worktrees,
          worktree: () => wt,
          settled: () => {
            const fresh = getJob(job.id, db);
            return !fresh || fresh.status === "aborted" || fresh.status === "interrupted";
          },
          resume: (rj, sessionId, failedLog, cwd) =>
            resumeAgentSession(rj, sessionId, failedLog, cwd, {
              db,
              provider,
              command,
              timeoutMs,
              costCapUsd: maxJobCostUsd,
            }),
        }),
        // Opt-in structured CI auto-healing (issue #16, ADR 017).
        autoHeal: repo.autoHealCi
          ? { headSha: (pr) => forge.prHeadSha(pr), provider: repo.platform }
          : undefined,
      }));
  // Opt-in post-PR verification (issue #54, ADR 027): a read-only one-shot that
  // checks whether the diff satisfies the issue/subtasks. Best-effort by
  // construction — runVerificationPass never throws and never merges.
  const runVerify =
    deps.verify ??
    ((j, prNumber) =>
      runVerificationPass({
        job: j,
        prNumber,
        repo,
        forge,
        db,
        provider,
        command,
        model: j.model ?? repo.defaultModel,
      }).then(() => undefined));

  try {
    wt = await worktrees.prepare(repo, job.id, job.issueNumber);
    recordEvent(job.id, "worktree", { path: wt.path, branch: wt.branch }, db);

    // Limit-resume (issue #166): a job parked on a provider limit resumes its
    // stored session (`--resume`) instead of starting from scratch, keeping
    // the conversation context. The marker is cleared up front: if this run
    // hits the limit again the park branch re-sets it; any other outcome must
    // not look limit-parked.
    const limitResume = !!job.limitKind && !!job.sessionId && provider.supportsResume;
    if (job.limitKind) {
      db.update(jobs).set({ limitKind: null }).where(eq(jobs.id, job.id)).run();
    }

    // Builds the full first-run prompt (issue context, subtasks, custom
    // instructions, optional plan stage) and spawns a fresh session. A closure
    // so the limit-resume path below skips it entirely — the resumed session
    // already carries all of this context.
    const runFreshSession = async (worktree: Worktree): Promise<AgentSessionResult> => {
      let prompt = renderTemplate(resolveTemplateContent(repo.id, TEMPLATE_NAMES.main, db), {
        ISSUE_NUM: job.issueNumber,
        BRANCH: worktree.branch,
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

      // Per-repo custom agent instructions (issue #56, opt-in): append the
      // operator's free-text guidance as a dedicated, length-capped section.
      // Empty/unset leaves the prompt untouched.
      prompt += agentInstructionsPromptSection(repo.agentInstructions);

      // Opt-in plan-first stage (issue #160): a read-only one-shot pass produces
      // an implementation plan that is posted on the issue (audit trail) and
      // embedded in the implementation prompt. Best-effort by construction: a
      // non-zero exit, an empty plan, or a failed comment falls back to the
      // normal single-stage run rather than failing the job.
      if (repo.planFirst) {
        const planPrompt = renderTemplate(
          resolveTemplateContent(repo.id, TEMPLATE_NAMES.plan, db),
          {
            ISSUE_NUM: job.issueNumber,
            BRANCH: worktree.branch,
            REPO_NAME: repo.name,
          },
        );
        try {
          const plan = await runPlan(getJob(job.id, db) as Job, planPrompt, worktree.path);
          const planText = plan.text.trim();
          if (plan.exitCode === 0 && planText.length > 0) {
            recordEvent(job.id, "status", { reason: "plan stage complete" }, db);
            prompt += planPromptSection(planText);
            try {
              await commentIssue(
                job.issueNumber,
                `**Implementation plan** (job ${job.id}):\n\n${planText}`,
              );
            } catch (err) {
              logError(`[run-job] plan comment failed for job ${job.id}`, err);
            }
          } else {
            recordEvent(
              job.id,
              "status",
              { reason: "plan stage failed, continuing without a plan", exitCode: plan.exitCode },
              db,
            );
          }
        } catch (err) {
          logError(`[run-job] plan stage failed for job ${job.id}`, err);
          recordEvent(
            job.id,
            "status",
            { reason: "plan stage failed, continuing without a plan" },
            db,
          );
        }
      }

      return runSession(getJob(job.id, db) as Job, prompt, worktree.path);
    };

    let session: AgentSessionResult;
    if (limitResume) {
      recordEvent(
        job.id,
        "status",
        { reason: "resuming session after provider limit", sessionId: job.sessionId },
        db,
      );
      if (repo.autoDecompose) markSubtasksWorking(repo.id, job.issueNumber, db);
      const resumePrompt = renderTemplate(
        resolveTemplateContent(repo.id, TEMPLATE_NAMES.limitResume, db),
        {
          ISSUE_NUM: job.issueNumber,
          BRANCH: wt.branch,
          REPO_NAME: repo.name,
        },
      );
      session = await resumeLimitSession(getJob(job.id, db) as Job, resumePrompt, wt.path);
    } else {
      session = await runFreshSession(wt);
    }
    // Defense in depth against concurrent aborts (abort action, emergency
    // stop, graceful shutdown): the kill races the session result, so re-read
    // the job and never commit, push, or open a PR for one that has settled.
    const afterSession = getJob(job.id, db) as Job;
    if (afterSession.status === "aborted" || afterSession.status === "interrupted") {
      if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
      return afterSession;
    }
    if (session.timedOut) {
      if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: `${provider.label} timed out after ${maxJobMinutes} minutes` },
        db,
      );
    }
    // Per-job cost ceiling reached (issue #57): the session was aborted
    // mid-stream. Its partial cost is already persisted (and counts toward the
    // day's spend); escalate to a human with a clear reason. Checked before the
    // exit-code branch since the abort yields a non-zero sentinel exit.
    if (session.costExceeded) {
      if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: `per-job cost limit of $${maxJobCostUsd} reached` },
        db,
      );
    }
    // Spawn error (ENOENT etc.): the CLI binary was not found or not executable.
    // Surface a clear diagnostic so operators know to install/configure the CLI,
    // rather than seeing a generic "exited non-zero" message.
    if (session.spawnError) {
      if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: `failed to start ${command}: ${session.spawnError.message}` },
        db,
      );
    }
    // Provider limit/auth conditions (issue #166), checked before the generic
    // exit-code branch so they never degrade into "exited non-zero". Transient
    // limits park the job for automatic resume; auth/billing need an operator.
    if (session.limit) {
      const limit = session.limit;
      if (limit.kind === "auth" || limit.kind === "billing") {
        if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
        const label = limit.kind === "auth" ? "authentication" : "billing";
        return transitionJob(
          job.id,
          "needs_human",
          {
            errorMessage: `${provider.label} ${label} error: ${limit.rawSnippet}`.slice(0, 500),
          },
          db,
        );
      }
      // Re-read the toggle: the session may have run for many minutes, and an
      // operator flipping auto-wait mid-session must take effect immediately.
      if (!limitAutoWaitEnabled(provider.id, db)) {
        if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
        return transitionJob(
          job.id,
          "needs_human",
          { errorMessage: `${limitParkMessage(limit.kind, limit.agent)} (auto-wait is disabled)` },
          db,
        );
      }
      return await parkOnLimit(limit);
    }
    if (session.exitCode !== 0) {
      if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: `${provider.label} exited non-zero` },
        db,
      );
    }

    // A successful session ends the provider-limit streak (issues #166/#167):
    // the next limit detection starts a fresh backoff instead of compounding.
    clearProviderLimit(provider.id, db);

    // Per-repo ADR gate: hold the merge while ADRs await review (SPEC opt-in).
    if (repo.adrGating) {
      const pending = listAdrs("pending_review", db, repo.id);
      if (pending.length > 0) {
        if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
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
        if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
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

    // Opt-in read-only verification of the opened PR (issue #54). Wrapped so a
    // failure is logged but never flips the job or blocks the merge path.
    if (repo.verifyPr) {
      try {
        await runVerify(getJob(job.id, db) as Job, prNumber);
      } catch (verifyErr) {
        const message = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        recordEvent(job.id, "error", { message: `verification pass failed: ${message}` }, db);
      }
    }

    const final = await runBabysitter(getJob(job.id, db) as Job, prNumber);
    if (repo.autoDecompose) {
      if (final.status === "merged") {
        markSubtasksDone(repo.id, job.issueNumber, db);
      } else {
        markSubtasksParked(repo.id, job.issueNumber, db);
      }
    }
    return final;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordEvent(job.id, "error", { message }, db);
    const current = getJob(job.id, db) as Job;
    // ci_failed is included so a throw between the babysitter's ci_failed and
    // retrying transitions parks the job for a human instead of stranding it
    // in a non-terminal state forever (which would block sequential repos).
    // waiting_limit is deliberately NOT included: a job that parked on a
    // provider limit is in a self-recovering state — the driver requeues it
    // when the latch clears — and a late throw must not degrade it to
    // needs_human (issue #166).
    if (["working", "ci_running", "ci_failed", "retrying"].includes(current.status)) {
      if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
      try {
        return transitionJob(job.id, "needs_human", { errorMessage: message.slice(0, 500) }, db);
      } catch (transitionErr) {
        if (!(transitionErr instanceof InvalidTransitionError)) throw transitionErr;
        // A concurrent abort flipped the job terminal between the status read
        // above and this write; the settled row is the outcome, not a new error.
        logError(
          `[run-job] job ${job.id} settled concurrently during failure handling`,
          transitionErr,
        );
        return getJob(job.id, db) as Job;
      }
    }
    return current;
  } finally {
    if (wt) {
      try {
        await worktrees.remove(wt, repo.path);
      } catch (cleanupErr) {
        logError(`[run-job] worktree cleanup failed for job ${job.id}`, cleanupErr);
      }
    }
  }
}
