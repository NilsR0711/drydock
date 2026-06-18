import { eq } from "drizzle-orm";
import { listAdrs } from "@/lib/adr/service";
import { getAgentProvider } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { followupIssues, jobs } from "@/lib/db/schema";
import type { StreamRunner } from "@/lib/exec/stream-runner";
import { getForge } from "@/lib/forge/registry";
import { EmptyCommitError, type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { listIssues, markIssueNeedsHuman } from "@/lib/issues/service";
import { listSubtasks } from "@/lib/issues/subtasks";
import { logError } from "@/lib/log/logger";
import type { NotificationEvent } from "@/lib/notify/events";
import { dispatch } from "@/lib/notify/notifier";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import { agentInstructionsPromptSection } from "@/lib/repos/agent-instructions";
import { isSandboxEnabled, resolveSandboxConfig } from "@/lib/sandbox/config";
import {
  type PrepareSandboxInput,
  type PrepareSandboxResult,
  prepareSandboxSession,
} from "@/lib/sandbox/session";
import { getSettings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import {
  type AgentSessionResult,
  resumeAgentSession,
  type SessionLimitInfo,
  spawnAgentSession,
} from "./agent-session";
import { ciBabysitter, type ResumeOutcome, resumeFailureReason } from "./ci-babysitter";
import {
  consumeFollowups as defaultConsumeFollowups,
  type FollowupIssue,
} from "./followups-metadata";
import { getJob, recordEvent, transitionJob } from "./jobs";
import { announceNeedsHuman as defaultAnnounceNeedsHuman } from "./needs-human";
import { runOneShotAndRecordCost } from "./one-shot-runner";
import { runPrAuditPass } from "./pr-audit-driver";
import { consumePrMetadata as defaultConsumePrMetadata, type PrMetadata } from "./pr-metadata";
import { nudgeAwareSleep } from "./pr-nudge";
import { clearProviderLimit, latchProviderLimit, limitAutoWaitEnabled } from "./provider-limit";
import { consumeQuestions as defaultConsumeQuestions } from "./questions-metadata";
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
  /**
   * Commit + push a parked job's work for a human to resume from (issue #249).
   * Resolves to whether anything was preserved (false for a genuine no-op).
   */
  commitAndPushForHuman(wt: Worktree, message: string): Promise<boolean>;
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
  /** Run the opt-in AI PR audit after the PR opens (issue #168); injectable for tests. */
  audit?: (job: Job, prNumber: number) => Promise<void>;
  notify?: NotifyEvent;
  /** Run the read-only plan stage (issue #160); injectable for tests. */
  runPlan?: (job: Job, prompt: string, cwd: string) => Promise<{ text: string; exitCode: number }>;
  /** Post a comment on the job's issue; injectable for tests. */
  commentIssue?: (issueNumber: number, body: string) => Promise<void>;
  /**
   * Open a follow-up issue for out-of-scope work the agent deferred (issue
   * #261); returns the new issue number. Injectable for tests; defaults to the
   * forge's `createIssue`.
   */
  createIssue?: (title: string, body: string) => Promise<number>;
  /**
   * Fetch the issue title+body to embed in the implement prompt (issue #205);
   * injectable for tests. Defaults to the forge's `viewIssue`.
   */
  viewIssue?: (issueNumber: number) => Promise<{ title: string; body: string }>;
  /**
   * Resume the stored session of a limit-parked job (issue #166); injectable
   * for tests. Defaults to resumeAgentSession on the job's own model.
   */
  resumeLimitSession?: (job: Job, prompt: string, cwd: string) => Promise<AgentSessionResult>;
  /**
   * Read and consume the agent-authored `.drydock/PR.md` from the worktree
   * (issue #212), returning the commit subject / PR title + body and removing
   * the file so it stays out of the commit. Injectable for tests; defaults to
   * the filesystem-backed reader.
   */
  consumePrMetadata?: (worktreePath: string) => PrMetadata | null;
  /**
   * Read and consume the agent-authored `.drydock/QUESTIONS.md` from the
   * worktree (issue #251), returning the open-questions block and removing the
   * file so it stays out of the preserved branch. Injectable for tests;
   * defaults to the filesystem-backed reader.
   */
  consumeQuestions?: (worktreePath: string) => string | null;
  /**
   * Read and consume the agent-authored `.drydock/FOLLOWUPS.md` from the
   * worktree (issue #261), returning the deferred follow-up issues and removing
   * the file so it stays out of the commit. Injectable for tests; defaults to
   * the filesystem-backed reader.
   */
  consumeFollowups?: (worktreePath: string) => FollowupIssue[];
  /**
   * Mark the job's issue as needing a human (issue #251): apply the needs-human
   * label and drop the queue label. Injectable for tests; defaults to the
   * forge-backed `markIssueNeedsHuman`.
   */
  markNeedsHuman?: (issueNumber: number) => Promise<void>;
  /**
   * Prepare the sandboxed-execution environment for a repo that opted into
   * `sandbox: docker` (issue #182, ADR 033); injectable for tests. Defaults to
   * prepareSandboxSession. Only invoked for CLI agents on opted-in repos.
   */
  prepareSandbox?: (input: PrepareSandboxInput) => Promise<PrepareSandboxResult>;
  /**
   * Make a parked job visible on its forge issue (issue #250): set the
   * needs-human label, drop the queue label, and comment the reason.
   * Injectable for tests; defaults to the forge-backed announcer. Best-effort —
   * a failure here never alters the job's settled outcome.
   */
  announceNeedsHuman?: (job: Job) => Promise<void>;
}

/** Keeps an unexpectedly verbose plan from flooding the work prompt. */
const PLAN_MAX_CHARS = 10_000;

// Bound the embedded issue text (issue #205) so a pathologically large issue
// body cannot blow the model's context window and fail the run before any
// implementation starts — the very failure mode embedding the body set out to
// fix. A truncation marker tells the agent the text was cut.
const ISSUE_TITLE_MAX_CHARS = 500;
const ISSUE_BODY_MAX_CHARS = 20_000;

/** Truncate to a max length with a clear marker, matching the plan-section cap. */
function capPromptText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

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

/**
 * File a GitHub issue for each agent-deferred follow-up (issue #261) and return
 * the resulting issue numbers in entry order, for linking from the PR body.
 *
 * Dedupe is scoped to the originating job: an entry whose title was already
 * filed for this job (a limit-resume rerun re-emitting the same
 * `.drydock/FOLLOWUPS.md`) reuses the recorded issue number instead of opening a
 * duplicate. Each filing is best-effort — a forge hiccup on one entry is logged
 * and skipped so it never strands the run or blocks the PR.
 */
async function fileFollowups(
  followups: FollowupIssue[],
  jobId: number,
  createIssue: (title: string, body: string) => Promise<number>,
  db: DB,
): Promise<number[]> {
  if (followups.length === 0) return [];
  const filed = new Map<string, number>(
    db
      .select()
      .from(followupIssues)
      .where(eq(followupIssues.jobId, jobId))
      .all()
      .map((row) => [row.title, row.ghIssueNumber] as const),
  );
  const numbers: number[] = [];
  for (const { title, body } of followups) {
    const existing = filed.get(title);
    if (existing !== undefined) {
      numbers.push(existing);
      continue;
    }
    try {
      const ghIssueNumber = await createIssue(title, body);
      db.insert(followupIssues).values({ jobId, ghIssueNumber, title }).run();
      filed.set(title, ghIssueNumber);
      numbers.push(ghIssueNumber);
    } catch (err) {
      logError(`[run-job] follow-up issue filing failed for job ${jobId}: ${title}`, err);
    }
  }
  return numbers;
}

/** Event-aware notification sink: routes a lifecycle event + message downstream. */
type NotifyEvent = (event: NotificationEvent, text: string) => Promise<void>;

/** Operator-facing description of a parked job's limit kind (issues #166/#167). */
export function limitParkMessage(kind: SessionLimitInfo["kind"], agent: AgentId): string {
  const [vendor, label] =
    agent === "codex"
      ? ["OpenAI", "Codex"]
      : agent === "openrouter"
        ? ["OpenRouter", "OpenRouter"]
        : ["Anthropic", "Claude"];
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
    // GitHub-side visibility for every needs_human outcome (issue #250),
    // whether parked directly in runJobCore or escalated by the CI babysitter:
    // both flow through this single return. Best-effort and self-contained, so
    // a forge failure cannot turn a settled park into a thrown error.
    const announce =
      deps.announceNeedsHuman ?? ((job: Job) => defaultAnnounceNeedsHuman(job, { db }));
    await announce(result);
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
  // Sandboxed execution (issue #182, ADR 033). Resolved up front but only
  // *applied* after the worktree exists (the image may come from its
  // devcontainer.json) and only for CLI agents — HTTP providers have no
  // subprocess to wrap. `sessionEnv` is the late-bound command/runner the
  // session closures read at invocation time: on the host today, or the bare
  // in-container command + a container-wrapping runner once a sandbox is
  // prepared below. Off-by-default repos leave it untouched (no behavior change).
  const sandboxConfig = resolveSandboxConfig(repo, settings);
  const sandboxRequested = isSandboxEnabled(sandboxConfig) && provider.kind !== "http";
  const prepareSandbox = deps.prepareSandbox ?? prepareSandboxSession;
  const sessionEnv: { command: string; runner?: StreamRunner } = { command };
  const runSession =
    deps.runSession ??
    ((j, prompt, cwd) =>
      spawnAgentSession(j, prompt, cwd, {
        db,
        provider,
        command: sessionEnv.command,
        runner: sessionEnv.runner,
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
  // Agent-authored follow-up issues (issue #261): file a real issue for each
  // out-of-scope item the agent deferred via `.drydock/FOLLOWUPS.md`.
  const createIssue =
    deps.createIssue ?? ((title: string, body: string) => forge.createIssue(title, body));
  // Issue context for the implement prompt (issue #205): the title+body are
  // embedded so a headless agent needs no GitHub access to learn the task.
  const viewIssue =
    deps.viewIssue ??
    ((issueNumber: number) =>
      forge.viewIssue(issueNumber).then((d) => ({ title: d.title, body: d.body })));
  // Agent-authored PR metadata (issue #212): read+remove `.drydock/PR.md` so the
  // commit and PR carry a meaningful subject/body instead of "Fix #N".
  const consumePrMetadata = deps.consumePrMetadata ?? defaultConsumePrMetadata;
  // Agent-authored open questions (issue #251): read+remove `.drydock/QUESTIONS.md`
  // and apply the needs-human label when the agent parks a blocking decision.
  const consumeQuestions = deps.consumeQuestions ?? defaultConsumeQuestions;
  const consumeFollowups = deps.consumeFollowups ?? defaultConsumeFollowups;
  const markNeedsHuman =
    deps.markNeedsHuman ?? ((issueNumber: number) => markIssueNeedsHuman(repo.id, issueNumber, db));
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
        command: sessionEnv.command,
        runner: sessionEnv.runner,
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
  // When a job parks for a human with real work to resume from (issue #249),
  // the finally cleanup is skipped so the agent's commits/branch survive. Set
  // by preserveWorktreeForHuman; a genuine no-op run leaves it false and is
  // cleaned up as before.
  let preserveWorktree = false;
  /**
   * Preserve a parked job's worktree (issue #249): commit any uncommitted
   * edits, push the branch, and return its name so the transition records it on
   * the job row. A genuine no-op preserves nothing (and the worktree is cleaned
   * up). A push failure still keeps the local worktree so committed work is not
   * discarded, but cannot report a pushed branch.
   */
  const preserveWorktreeForHuman = async (): Promise<string | undefined> => {
    if (!wt) return undefined;
    try {
      const preserved = await worktrees.commitAndPushForHuman(
        wt,
        `wip: park #${job.issueNumber} for human review`,
      );
      if (!preserved) return undefined;
      preserveWorktree = true;
      return wt.branch;
    } catch (err) {
      logError(`[run-job] failed to push preserved worktree for job ${job.id}`, err);
      // Keep the local worktree even when the push failed: the agent's
      // committed work must not be thrown away just because it could not reach
      // the forge. No pushed branch to record, though.
      preserveWorktree = true;
      return undefined;
    }
  };
  /**
   * Park the job for a human (issue #249): mark any subtasks parked, preserve
   * the worktree/branch when there is work, and transition to needs_human
   * recording the preserved branch (when one was pushed). Folds together the
   * bookkeeping every pre-PR escalation shares.
   */
  const parkForHuman = async (errorMessage: string): Promise<Job> => {
    if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
    const branch = await preserveWorktreeForHuman();
    const patch: Partial<Job> = { errorMessage: errorMessage.slice(0, 500) };
    if (branch) patch.branch = branch;
    return transitionJob(job.id, "needs_human", patch, db);
  };
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
        // No-checks merge policy (issue #207): when on, a PR that reports no CI
        // checks at all is merged after the settle window instead of escalating
        // — for repos whose CI is manual-only or review-bot-only.
        mergeWithoutChecks: repo.mergeWithoutChecks,
        // Webhook nudge (issue #180): a verified check_suite/check_run (or
        // pipeline) delivery wakes this sleep so the next poll — and with it
        // the merge gate — advances within seconds instead of at the poll
        // interval. Without a webhook the timeout is just a normal poll.
        sleep: nudgeAwareSleep({
          repoId: repo.id,
          prNumber,
          onNudge: (reason) =>
            recordEvent(job.id, "status", { reason: `woken by webhook: ${reason}`, prNumber }, db),
        }),
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
              command: sessionEnv.command,
              runner: sessionEnv.runner,
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
  // Opt-in AI PR audit (issue #168): a read-only whole-PR review posted on the
  // issue. Best-effort by construction — runPrAuditPass never throws and never
  // touches job state; it resolves its own agent/model from the repo settings.
  const runAudit =
    deps.audit ??
    ((j: Job, prNumber: number) =>
      runPrAuditPass({ job: j, prNumber, repo, forge, db }).then(() => undefined));

  try {
    wt = await worktrees.prepare(repo, job.id, job.issueNumber);
    recordEvent(job.id, "worktree", { path: wt.path, branch: wt.branch }, db);

    // Sandboxed execution preflight (issue #182, ADR 033): detect a usable
    // container runtime, resolve the image, and build the container-wrapping
    // runner. A missing runtime / unresolvable image escalates to needs_human
    // with a clear reason instead of failing opaquely at spawn time. Only the
    // implement and resume sessions are wrapped; read-only one-shot passes
    // (plan/verify/audit) stay on the host.
    if (sandboxRequested) {
      const prepared = await prepareSandbox({
        config: sandboxConfig,
        worktreePath: wt.path,
        jobId: job.id,
        agent: provider.id,
        inContainerCommand: provider.defaultCommand,
        preferredRuntime: settings.containerRuntime,
      });
      if (!prepared.ok) {
        return await parkForHuman(`Sandbox preflight failed: ${prepared.reason}`);
      }
      sessionEnv.runner = prepared.session.runner;
      sessionEnv.command = prepared.session.command;
      recordEvent(job.id, "status", { reason: `sandboxed execution (${sandboxConfig.mode})` }, db);
    }

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
      // Record which revision of the implement prompt this run resolved (issue
      // #178) so analytics can slice outcomes by prompt version. Null marks a
      // run on the code-level default template.
      const mainTemplate = resolveTemplate(repo.id, TEMPLATE_NAMES.main, db);
      db.update(jobs)
        .set({ implementPromptVersion: mainTemplate.version })
        .where(eq(jobs.id, job.id))
        .run();
      // Embed the issue title+body directly (issue #205) so the headless agent
      // learns what to build without GitHub access — under acceptEdits its `gh`
      // calls block on an approval that never comes. Best-effort: a fetch
      // failure falls back to empty context (the prompt still carries the issue
      // number) rather than failing the job before any work runs.
      let issue = { title: "", body: "" };
      try {
        issue = await viewIssue(job.issueNumber);
      } catch (err) {
        logError(`[run-job] failed to fetch issue #${job.issueNumber} for job ${job.id}`, err);
      }
      const issueTitle = capPromptText(issue.title, ISSUE_TITLE_MAX_CHARS);
      const issueBody = capPromptText(issue.body, ISSUE_BODY_MAX_CHARS);
      let prompt = renderTemplate(mainTemplate.content, {
        ISSUE_NUM: job.issueNumber,
        BRANCH: worktree.branch,
        REPO_NAME: repo.name,
        ISSUE_TITLE: issueTitle,
        ISSUE_BODY: issueBody,
        // The PR body structure is its own per-repo template (issue #252),
        // injected here so the agent writes `.drydock/PR.md` in the repo's shape.
        PR_FORMAT: resolveTemplateContent(repo.id, TEMPLATE_NAMES.prFormat, db),
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
            ISSUE_TITLE: issueTitle,
            ISSUE_BODY: issueBody,
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
          // Keep the resumed run's PR body in the repo's shape too (issue #252).
          PR_FORMAT: resolveTemplateContent(repo.id, TEMPLATE_NAMES.prFormat, db),
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
      return await parkForHuman(`${provider.label} timed out after ${maxJobMinutes} minutes`);
    }
    // Per-job cost ceiling reached (issue #57): the session was aborted
    // mid-stream. Its partial cost is already persisted (and counts toward the
    // day's spend); escalate to a human with a clear reason. Checked before the
    // exit-code branch since the abort yields a non-zero sentinel exit.
    if (session.costExceeded) {
      return await parkForHuman(`per-job cost limit of $${maxJobCostUsd} reached`);
    }
    // Spawn error (ENOENT etc.): the CLI binary was not found or not executable.
    // Surface a clear diagnostic so operators know to install/configure the CLI,
    // rather than seeing a generic "exited non-zero" message.
    if (session.spawnError) {
      return await parkForHuman(`failed to start ${command}: ${session.spawnError.message}`);
    }
    // Provider limit/auth conditions (issue #166), checked before the generic
    // exit-code branch so they never degrade into "exited non-zero". Transient
    // limits park the job for automatic resume; auth/billing need an operator.
    if (session.limit) {
      const limit = session.limit;
      if (limit.kind === "auth" || limit.kind === "billing") {
        const label = limit.kind === "auth" ? "authentication" : "billing";
        return await parkForHuman(`${provider.label} ${label} error: ${limit.rawSnippet}`);
      }
      // Re-read the toggle: the session may have run for many minutes, and an
      // operator flipping auto-wait mid-session must take effect immediately.
      if (!limitAutoWaitEnabled(provider.id, db)) {
        return await parkForHuman(
          `${limitParkMessage(limit.kind, limit.agent)} (auto-wait is disabled)`,
        );
      }
      return await parkOnLimit(limit);
    }
    if (session.exitCode !== 0) {
      return await parkForHuman(`${provider.label} exited non-zero`);
    }

    // A successful session ends the provider-limit streak (issues #166/#167):
    // the next limit detection starts a fresh backoff instead of compounding.
    clearProviderLimit(provider.id, db);

    // Agent-authored open questions (issue #251): if the agent wrote
    // `.drydock/QUESTIONS.md`, it hit a decision only a human can make. Hand it
    // off autonomously instead of opening a PR: preserve whatever partial, safe
    // work it committed by pushing the branch, post the questions as an issue
    // comment, apply the needs-human label, and park the job in needs_human.
    // Consuming the file removes it so the scratch never lands in the branch.
    const questions = consumeQuestions(wt.path);
    if (questions) {
      if (repo.autoDecompose) markSubtasksParked(repo.id, job.issueNumber, db);
      // Preserve the branch + commits. A questions-only run with no other
      // change leaves nothing to push (EmptyCommitError) — that is fine; there
      // is simply no partial work to keep, so park on the questions alone.
      try {
        await worktrees.commitAndPush(
          wt,
          `Partial work for #${job.issueNumber} (parked for review)`,
        );
      } catch (err) {
        if (!(err instanceof EmptyCommitError)) throw err;
      }
      // Best-effort handoff breadcrumbs: a forge hiccup must not strand the job
      // in a non-terminal state, so a failed comment/label is logged, not fatal.
      try {
        await commentIssue(
          job.issueNumber,
          `🙋 Drydock needs a human decision before continuing on #${job.issueNumber}:\n\n${questions}`,
        );
      } catch (err) {
        logError(`[run-job] questions comment failed for job ${job.id}`, err);
      }
      try {
        await markNeedsHuman(job.issueNumber);
      } catch (err) {
        logError(`[run-job] needs-human label failed for job ${job.id}`, err);
      }
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: "agent has open questions", branch: wt.branch },
        db,
      );
    }

    // Per-repo ADR gate: hold the merge while ADRs await review (SPEC opt-in).
    if (repo.adrGating) {
      const pending = listAdrs("pending_review", db, repo.id);
      if (pending.length > 0) {
        return await parkForHuman(`Blocked by ${pending.length} pending ADR review(s).`);
      }
    }

    // Consume the agent-authored PR metadata (issue #212) before committing, so
    // the commit subject is meaningful and `.drydock/PR.md` is removed from the
    // working tree before `git add -A` stages it. Absent/unusable falls back to
    // the issue-based defaults below.
    const prMeta = consumePrMetadata(wt.path);
    // Agent-deferred follow-ups (issue #261): read+remove `.drydock/FOLLOWUPS.md`
    // here, alongside `.drydock/PR.md`, so the scratch is gone before `git add
    // -A` stages it. The issues are filed only after the commit/push succeeds.
    const followups = consumeFollowups(wt.path);
    const commitMessage = prMeta?.title ?? `Fix #${job.issueNumber}`;
    try {
      await worktrees.commitAndPush(wt, commitMessage);
    } catch (err) {
      // A legitimate no-op run (the issue needed no code change) produces an
      // empty commit. Report it as a clear outcome rather than a raw git error
      // (issue #50). Any other failure (e.g. a rejected push) still propagates.
      if (err instanceof EmptyCommitError) {
        // A genuine no-op: parkForHuman preserves nothing and the worktree is
        // cleaned up as before.
        return await parkForHuman("Agent produced no changes");
      }
      throw err;
    }
    const title =
      prMeta?.title ??
      listIssues(repo.id, db).find((i) => i.number === job.issueNumber)?.title ??
      `Fix #${job.issueNumber}`;
    // File the deferred follow-ups now that the work is committed (issue #261),
    // so a no-op run never opens stray issues, then link them from the PR body.
    const spunOff = await fileFollowups(followups, job.id, createIssue, db);
    // Always close the issue from the PR; append the marker to the agent's body
    // when present, otherwise the marker is the whole body (prior behavior).
    const closes = `Closes #${job.issueNumber}`;
    const spunOffLine =
      spunOff.length > 0 ? `Spun off: ${spunOff.map((n) => `#${n}`).join(", ")}` : "";
    const body = [prMeta?.body, closes, spunOffLine].filter(Boolean).join("\n\n");
    const prNumber = await createPr({
      head: wt.branch,
      base: repo.defaultBranch,
      title,
      body,
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

    // Opt-in AI PR audit (issue #168), after the cheaper verification pass.
    // Wrapped so a failure is logged but never flips the job or blocks merge.
    if (repo.autoPrAudit) {
      try {
        await runAudit(getJob(job.id, db) as Job, prNumber);
      } catch (auditErr) {
        const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
        recordEvent(job.id, "error", { message: `pr audit failed: ${message}` }, db);
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
      // Preserve the agent's work before parking (issue #249): a throw here can
      // strand real commits in the worktree (a failed push, a createPr error
      // after the branch was already pushed). Best-effort and never re-throws.
      const branch = await preserveWorktreeForHuman();
      try {
        const patch: Partial<Job> = { errorMessage: message.slice(0, 500) };
        if (branch) patch.branch = branch;
        return transitionJob(job.id, "needs_human", patch, db);
      } catch (transitionErr) {
        if (!(transitionErr instanceof InvalidTransitionError)) throw transitionErr;
        // A concurrent abort flipped the job terminal between the status read
        // above and this write; the settled row is the outcome, not a new error.
        logError(
          `[run-job] job ${job.id} settled concurrently during failure handling`,
          transitionErr,
        );
        const settled = getJob(job.id, db) as Job;
        // The needs_human park never landed, so there is nothing to preserve
        // for: undo the flag the preserve set above so the worktree of a now
        // settled (e.g. aborted) job is still cleaned up (issue #249).
        if (settled.status !== "needs_human") preserveWorktree = false;
        return settled;
      }
    }
    return current;
  } finally {
    // Keep the worktree when a job parked for a human with real work to resume
    // from (issue #249); otherwise remove it. Merged/aborted and genuine no-op
    // runs leave preserveWorktree false and clean up as before. A preserved
    // needs_human job is non-terminal, so the worktree reaper leaves it alone
    // too — it is reclaimed on resume (prepare re-creates it) or once the job
    // reaches a terminal state.
    if (wt && !preserveWorktree) {
      try {
        await worktrees.remove(wt, repo.path);
      } catch (cleanupErr) {
        logError(`[run-job] worktree cleanup failed for job ${job.id}`, cleanupErr);
      }
    }
  }
}
