import { type ZodRawShape, z } from "zod";
import type { DB } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import { resolveDefaultBranch } from "@/lib/git/default-branch";
import {
  applyIssueLabels,
  dequeueIssue,
  listIssues,
  queueIssue,
  syncRepoIssues,
} from "@/lib/issues/service";
import { isKnownModelId } from "@/lib/models";
import { requeueJobWithEscalation } from "@/lib/orchestrator/escalation";
import { getJob, listJobs, transitionJob } from "@/lib/orchestrator/jobs";
import { startPrAudit } from "@/lib/orchestrator/pr-audit-driver";
import { questionSchema, startPrQuestion } from "@/lib/orchestrator/pr-question-service";
import { getPrQuestion } from "@/lib/orchestrator/pr-questions";
import { resumeJobWithInstruction } from "@/lib/orchestrator/resume-instruction";
import { isGitRepoPath } from "@/lib/repos/path";
import { addRepo } from "@/lib/repos/service";
import { getSettings, jobsAllowed, repoJobsAllowed, saveSettings } from "@/lib/settings/service";
import { getBroker } from "@/lib/stream/broker";
import { addTrackedPrByUrl } from "@/lib/tracked-prs/resolve";
import { getTrackedPr, listTrackedPrs, untrackPr } from "@/lib/tracked-prs/service";

/**
 * Dependencies a tool handler runs against. Only the DB is injected; the forge,
 * broker and runtime are reached through their own service-layer singletons,
 * which all default to this same DB in production.
 */
export interface ToolContext {
  db: DB;
}

/**
 * A single MCP tool. `inputSchema` is a Zod raw shape (the SDK validates client
 * input against it); `handler` returns plain JSON-serialisable data that the
 * server wraps into an MCP tool result.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown;
}

function parseArgs<S extends ZodRawShape>(shape: S, args: unknown): z.infer<z.ZodObject<S>> {
  return z.object(shape).parse(args);
}

/** Settings keys that carry credentials and must never be returned verbatim. */
const SECRET_SETTINGS = ["telegramBotToken", "slackWebhookUrl", "smtpPass"] as const;

/** Mask non-empty credential fields so secrets never leave the process. */
function redactSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out = { ...settings };
  for (const key of SECRET_SETTINGS) {
    if (typeof out[key] === "string" && out[key] !== "") out[key] = "***";
  }
  return out;
}

/**
 * The same gate the driver loop applies before starting work: refuse to
 * initiate new work while the orchestrator is draining, globally paused, over
 * the daily cost limit, or the repo is over its own limit (issue #21 safety).
 * All gates are DB-backed: the MCP server runs as its own process, so the
 * orchestrator's in-memory state is invisible here.
 */
function assertWorkAllowed(repoId: number, db: DB): void {
  const global = jobsAllowed(db);
  if (global.reason === "draining") {
    throw new Error("Drydock is draining; not accepting new work");
  }
  if (!global.allowed) throw new Error(`work blocked by gate: ${global.reason}`);
  const repo = repoJobsAllowed(repoId, db);
  if (!repo.allowed) throw new Error(`work blocked by gate: ${repo.reason}`);
}

const repoIdShape = { repoId: z.number().int().positive() } satisfies ZodRawShape;
const issueRefShape = {
  repoId: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
} satisfies ZodRawShape;
const jobIdShape = { jobId: z.number().int().positive() } satisfies ZodRawShape;
const resumeWithInstructionShape = {
  jobId: z.number().int().positive(),
  instruction: z.string().min(1),
} satisfies ZodRawShape;

const addRepoShape = {
  // A remote MCP host could otherwise register an arbitrary directory; require a
  // real local git repository (a `.git` dir or worktree pointer) — issue #110.
  path: z
    .string()
    .min(1)
    .refine(isGitRepoPath, { message: "path must be an existing directory containing a .git" }),
  name: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  platform: z.enum(["github", "gitlab"]).optional(),
  defaultModel: z
    .string()
    .min(1)
    .refine(isKnownModelId, { message: "unknown model id" })
    .optional(),
  dailyCostLimitUsd: z.number().nonnegative().optional(),
  monthlyCostLimitUsd: z.number().nonnegative().optional(),
} satisfies ZodRawShape;

const setLabelsShape = {
  repoId: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
} satisfies ZodRawShape;

const getLogsShape = {
  jobId: z.number().int().positive(),
  limit: z.number().int().positive().max(1000).optional(),
} satisfies ZodRawShape;

const askPrQuestionShape = {
  jobId: z.number().int().positive(),
  // Reuse the shared validator (trim + min + MAX_QUESTION_CHARS) so the
  // advertised MCP input schema never drifts from what startPrQuestion enforces.
  question: questionSchema,
} satisfies ZodRawShape;

const drainShape = { on: z.boolean() } satisfies ZodRawShape;

const trackPrShape = {
  repoId: z.number().int().positive(),
  url: z.string().url(),
  // Off by default (issue #293): externally-authored PRs are only auto-merged
  // when an operator opts this PR in (and even then only owned, clean branches).
  autoMerge: z.boolean().optional(),
} satisfies ZodRawShape;
const trackedPrIdShape = { trackedPrId: z.number().int().positive() } satisfies ZodRawShape;

/** Operationally-safe settings a remote host may change (no credential fields). */
const updateSettingsShape = {
  paused: z.boolean().optional(),
  dailyCostLimitUsd: z.number().nonnegative().optional(),
  monthlyCostLimitUsd: z.number().nonnegative().optional(),
  pollIntervalSec: z.number().int().positive().optional(),
  maxParallelJobs: z.number().int().positive().optional(),
  // 0 = unlimited turn budget (issue #254); a positive value caps it.
  maxTurns: z.number().int().nonnegative().optional(),
  defaultModel: z
    .string()
    .min(1)
    .refine(isKnownModelId, { message: "unknown model id" })
    .optional(),
  defaultAgent: z.enum(["claude", "codex"]).optional(),
  retentionDays: z.number().int().positive().optional(),
  // 0 disables the in-process daily DB backup sweep (issue #411).
  backupRetentionDays: z.number().int().nonnegative().optional(),
} satisfies ZodRawShape;

export const tools: ToolDef[] = [
  // ---- Repos ------------------------------------------------------------
  {
    name: "list_repos",
    description: "List all repositories registered with Drydock.",
    inputSchema: {},
    handler: (_args, { db }) => listRepos(db),
  },
  {
    name: "add_repo",
    description: "Register a new repository by local path and display name.",
    inputSchema: addRepoShape,
    handler: async (args, { db }) => {
      const parsed = parseArgs(addRepoShape, args);
      // Detect the clone's real default branch when the host omitted it, so a
      // repo on `master` does not fail its first job with "invalid ref: main"
      // (issue #210).
      const defaultBranch = await resolveDefaultBranch(parsed);
      return addRepo({ ...parsed, defaultBranch }, db);
    },
  },
  {
    name: "sync_repo_issues",
    description: "Fetch open issues for a repo from its forge and refresh the local cache.",
    inputSchema: repoIdShape,
    handler: async (args, { db }) => {
      const { repoId } = parseArgs(repoIdShape, args);
      return syncRepoIssues(repoId, db);
    },
  },
  // ---- Issues -----------------------------------------------------------
  {
    name: "list_issues",
    description: "List the cached issues for a repo, ordered by manual priority.",
    inputSchema: repoIdShape,
    handler: (args, { db }) => {
      const { repoId } = parseArgs(repoIdShape, args);
      return listIssues(repoId, db);
    },
  },
  {
    name: "add_to_queue",
    description: "Add a repo's queue label to an issue so the orchestrator will process it.",
    inputSchema: issueRefShape,
    handler: async (args, { db }) => {
      const { repoId, issueNumber } = parseArgs(issueRefShape, args);
      assertWorkAllowed(repoId, db);
      return queueIssue(repoId, issueNumber, {}, db);
    },
  },
  {
    name: "remove_from_queue",
    description: "Remove a repo's queue label from an issue.",
    inputSchema: issueRefShape,
    handler: async (args, { db }) => {
      const { repoId, issueNumber } = parseArgs(issueRefShape, args);
      return dequeueIssue(repoId, issueNumber, db);
    },
  },
  {
    name: "set_issue_labels",
    description: "Add and/or remove labels on an issue via the forge.",
    inputSchema: setLabelsShape,
    handler: async (args, { db }) => {
      const { repoId, issueNumber, add, remove } = parseArgs(setLabelsShape, args);
      await applyIssueLabels(repoId, issueNumber, add ?? [], remove ?? [], db);
      return listIssues(repoId, db);
    },
  },
  // ---- Jobs -------------------------------------------------------------
  {
    name: "list_jobs",
    description: "List jobs for a repo, newest first.",
    inputSchema: repoIdShape,
    handler: (args, { db }) => {
      const { repoId } = parseArgs(repoIdShape, args);
      return listJobs(repoId, db);
    },
  },
  {
    name: "get_job",
    description: "Get a single job by id.",
    inputSchema: jobIdShape,
    handler: (args, { db }) => {
      const { jobId } = parseArgs(jobIdShape, args);
      const job = getJob(jobId, db);
      if (!job) throw new Error(`job ${jobId} not found`);
      return job;
    },
  },
  {
    name: "requeue_job",
    description:
      "Put a needs_human, interrupted, or waiting_limit job back in the queue for another attempt.",
    inputSchema: jobIdShape,
    handler: (args, { db }) => {
      const { jobId } = parseArgs(jobIdShape, args);
      const job = getJob(jobId, db);
      if (!job) throw new Error(`job ${jobId} not found`);
      assertWorkAllowed(job.repoId, db);
      // Escalates the model one rung when the repo opted in (issue #179).
      return requeueJobWithEscalation(jobId, db);
    },
  },
  {
    name: "resume_job_with_instruction",
    description:
      "Unblock a needs_human job with guidance: store an instruction on the job and requeue it. " +
      "The next run resumes the stored session with the instruction as the prompt, on the job's " +
      "preserved branch, so the agent continues its prior work taking the guidance into account.",
    inputSchema: resumeWithInstructionShape,
    handler: (args, { db }) => {
      const { jobId, instruction } = parseArgs(resumeWithInstructionShape, args);
      const job = getJob(jobId, db);
      if (!job) throw new Error(`job ${jobId} not found`);
      assertWorkAllowed(job.repoId, db);
      return resumeJobWithInstruction(jobId, instruction, db);
    },
  },
  {
    name: "abort_job",
    description:
      "Permanently abort a job that will not be retried. A running agent subprocess is " +
      "terminated by the orchestrator on its next poll tick (the MCP server runs in its own " +
      "process and signals the abort through the database).",
    inputSchema: jobIdShape,
    handler: (args, { db }) => {
      const { jobId } = parseArgs(jobIdShape, args);
      const job = getJob(jobId, db);
      if (!job) throw new Error(`job ${jobId} not found`);
      // Flipping the row to `aborted` IS the cross-process abort signal: the
      // orchestrator's driver tick reconciles aborted rows against its
      // in-process abort registry and kills the live subprocess.
      return transitionJob(jobId, "aborted", {}, db);
    },
  },
  // ---- Tracked PRs (issue #293) ----------------------------------------
  {
    name: "track_pr",
    description:
      "Babysit an existing pull request by URL: Drydock watches its CI, runs review " +
      "feedback, and (only when opted in via autoMerge AND the branch is one we own) " +
      "auto-merges it. Externally-authored and fork PRs are watched but never merged or " +
      "pushed to. The PR is tracked regardless of the repo's issue watch scope.",
    inputSchema: trackPrShape,
    handler: async (args, { db }) => {
      const { repoId, url, autoMerge } = parseArgs(trackPrShape, args);
      assertWorkAllowed(repoId, db);
      return addTrackedPrByUrl({ repoId, url, autoMerge }, { db });
    },
  },
  {
    name: "list_tracked_prs",
    description: "List the PRs Drydock is tracking for a repo, newest first.",
    inputSchema: repoIdShape,
    handler: (args, { db }) => {
      const { repoId } = parseArgs(repoIdShape, args);
      return listTrackedPrs(repoId, db);
    },
  },
  {
    name: "untrack_pr",
    description: "Stop tracking a PR (the record is kept for history; re-add by URL to resume).",
    inputSchema: trackedPrIdShape,
    handler: (args, { db }) => {
      const { trackedPrId } = parseArgs(trackedPrIdShape, args);
      const tracked = getTrackedPr(trackedPrId, db);
      if (!tracked) throw new Error(`tracked PR ${trackedPrId} not found`);
      return untrackPr(trackedPrId, db);
    },
  },
  // ---- System -----------------------------------------------------------
  {
    name: "get_settings",
    description: "Get the global Drydock settings (credential fields are redacted).",
    inputSchema: {},
    handler: (_args, { db }) => redactSettings(getSettings(db) as Record<string, unknown>),
  },
  {
    name: "update_settings",
    description:
      "Update operational settings (pause, cost limit, concurrency, …). Credential fields cannot be set here.",
    inputSchema: updateSettingsShape,
    handler: (args, { db }) => {
      const patch = parseArgs(updateSettingsShape, args);
      const merged = saveSettings(patch, db) as Record<string, unknown>;
      return redactSettings(merged);
    },
  },
  {
    name: "set_drain_mode",
    description:
      "Enable or disable drain mode (stop picking up new work; let in-flight jobs finish). " +
      "Persisted in settings so it reaches the orchestrator process and survives restarts; " +
      "disable it by calling with on=false.",
    inputSchema: drainShape,
    handler: (args, { db }) => {
      const { on } = parseArgs(drainShape, args);
      // DB-backed (like `paused`): the orchestrator runs in another process and
      // polls settings each tick, so an in-memory flag here would be a no-op.
      const merged = saveSettings({ draining: on }, db);
      return { draining: merged.draining };
    },
  },
  {
    name: "get_logs",
    description: "Replay the most recent persisted log events for a job.",
    inputSchema: getLogsShape,
    handler: (args) => {
      const { jobId, limit } = parseArgs(getLogsShape, args);
      return getBroker().replay(jobId, limit);
    },
  },
  {
    name: "run_pr_audit",
    description:
      "Run the read-only AI PR audit for a job's open PR (issue #168): a structured review is " +
      "posted on the linked issue. Advisory only; job state is never touched.",
    inputSchema: jobIdShape,
    handler: (args, { db }) => {
      const { jobId } = parseArgs(jobIdShape, args);
      const job = getJob(jobId, db);
      if (!job) throw new Error(`job ${jobId} not found`);
      assertWorkAllowed(job.repoId, db);
      // Fire-and-forget: the audit can take minutes and persists its own
      // events; the pass never rejects, so nothing is left unhandled.
      const { prNumber } = startPrAudit(jobId, db);
      return { jobId, prNumber, status: "audit_started" };
    },
  },
  {
    name: "ask_pr_question",
    description:
      "Ask a free-text question about a job's open PR (issue #55) and get the answer back. A " +
      "read-only QA agent answers from the PR's assembled context (metadata, CI state, review " +
      "feedback, activity log, diff); it never edits files or touches job state. The call blocks " +
      "until the question reaches a terminal state and returns the persisted record with its " +
      "`status` (answered | error), `answer`, and `errorMessage`. Like the dashboard's ask path, " +
      "this is an on-demand read-only query and is not gated by the work-allowed checks.",
    inputSchema: askPrQuestionShape,
    handler: async (args, { db }) => {
      const { jobId, question } = parseArgs(askPrQuestionShape, args);
      // startPrQuestion validates the question and the job's PR, throwing before
      // any record is created on a bad request. We await the background run (it
      // never throws and is bounded by the driver's timeout) so the host gets
      // the answer in-band rather than having to poll.
      const { record, done } = startPrQuestion(jobId, question, db);
      await done;
      return getPrQuestion(record.id, db) ?? record;
    },
  },
];
