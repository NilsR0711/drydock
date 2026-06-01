import { type ZodRawShape, z } from "zod";
import type { DB } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import {
  applyIssueLabels,
  dequeueIssue,
  listIssues,
  queueIssue,
  syncRepoIssues,
} from "@/lib/issues/service";
import { isKnownModelId } from "@/lib/models";
import { getJob, listJobs, transitionJob } from "@/lib/orchestrator/jobs";
import { isDraining, setDrainMode } from "@/lib/orchestrator/runtime";
import { isGitRepoPath } from "@/lib/repos/path";
import { addRepo } from "@/lib/repos/service";
import { getSettings, jobsAllowed, repoJobsAllowed, saveSettings } from "@/lib/settings/service";
import { getBroker } from "@/lib/stream/broker";

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
 */
function assertWorkAllowed(repoId: number, db: DB): void {
  if (isDraining()) throw new Error("Drydock is draining; not accepting new work");
  const global = jobsAllowed(db);
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

const drainShape = { on: z.boolean() } satisfies ZodRawShape;

/** Operationally-safe settings a remote host may change (no credential fields). */
const updateSettingsShape = {
  paused: z.boolean().optional(),
  dailyCostLimitUsd: z.number().nonnegative().optional(),
  pollIntervalSec: z.number().int().positive().optional(),
  maxParallelJobs: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  defaultModel: z
    .string()
    .min(1)
    .refine(isKnownModelId, { message: "unknown model id" })
    .optional(),
  defaultAgent: z.enum(["claude", "codex"]).optional(),
  retentionDays: z.number().int().positive().optional(),
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
    handler: (args, { db }) => addRepo(parseArgs(addRepoShape, args), db),
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
    description: "Put a needs_human or interrupted job back in the queue for another attempt.",
    inputSchema: jobIdShape,
    handler: (args, { db }) => {
      const { jobId } = parseArgs(jobIdShape, args);
      const job = getJob(jobId, db);
      if (!job) throw new Error(`job ${jobId} not found`);
      assertWorkAllowed(job.repoId, db);
      return transitionJob(jobId, "queued", {}, db);
    },
  },
  {
    name: "abort_job",
    description: "Permanently abort a job that will not be retried.",
    inputSchema: jobIdShape,
    handler: (args, { db }) => {
      const { jobId } = parseArgs(jobIdShape, args);
      const job = getJob(jobId, db);
      if (!job) throw new Error(`job ${jobId} not found`);
      return transitionJob(jobId, "aborted", {}, db);
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
      "Enable or disable drain mode (stop picking up new work; let in-flight jobs finish).",
    inputSchema: drainShape,
    handler: (args) => {
      const { on } = parseArgs(drainShape, args);
      setDrainMode(on);
      return { draining: isDraining() };
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
];
