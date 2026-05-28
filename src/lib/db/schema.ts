import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable("repos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  queueLabel: text("queue_label").notNull().default("drydock:queue"),
  workingLabel: text("working_label").notNull().default("drydock:working"),
  needsHumanLabel: text("needs_human_label").notNull().default("drydock:needs-human"),
  defaultModel: text("default_model").notNull().default("claude-opus-4-7"),
  agent: text("agent").notNull().default("claude"),
  platform: text("platform").notNull().default("github"),
  apiBaseUrl: text("api_base_url"),
  apiToken: text("api_token"),
  dailyCostLimitUsd: real("daily_cost_limit_usd").notNull().default(10),
  adrGating: integer("adr_gating", { mode: "boolean" }).notNull().default(false),
  sequential: integer("sequential", { mode: "boolean" }).notNull().default(true),
  // Opt-in autonomous automation (both default off). See ADR 016.
  autoTriageEnabled: integer("auto_triage_enabled", { mode: "boolean" }).notNull().default(false),
  autoProcessEnabled: integer("auto_process_enabled", { mode: "boolean" }).notNull().default(false),
  // Opt-in CI auto-healing (default off). See ADR 017.
  autoHealCi: integer("auto_heal_ci", { mode: "boolean" }).notNull().default(false),
  // Opt-in PR review-feedback lifecycle (default off). See ADR 019.
  autoReviewFeedback: integer("auto_review_feedback", { mode: "boolean" }).notNull().default(false),
  // Bounded merge-conflict repair within the feedback loop (default off).
  autoResolveMergeConflicts: integer("auto_resolve_merge_conflicts", { mode: "boolean" })
    .notNull()
    .default(false),
  // Post incremental "working on it" replies (default off, to avoid noise).
  includeProgressReplies: integer("include_progress_replies", { mode: "boolean" })
    .notNull()
    .default(false),
  // Opt-in decomposition of large issues into tracked subtasks (default off).
  // See ADR 020.
  autoDecompose: integer("auto_decompose", { mode: "boolean" }).notNull().default(false),
  // Opt-in post-PR verification pass (default off). See ADR 027. After a PR is
  // opened, a read-only one-shot agent checks whether the diff satisfies the
  // issue and its subtasks; the result updates subtask status and surfaces a
  // summary. Never auto-merges and never corrupts state on failure.
  verifyPr: integer("verify_pr", { mode: "boolean" }).notNull().default(false),
  // Opt-in post-merge deployment healing (default off). See ADR 021. When a
  // monitored deployment fails, a follow-up fix PR is opened with the logs.
  autoHealDeployments: integer("auto_heal_deployments", { mode: "boolean" })
    .notNull()
    .default(false),
  // Explicit deployment-platform override (e.g. "vercel"/"railway"). Null lets
  // Drydock auto-detect the platform from the repo's config files.
  deploymentPlatform: text("deployment_platform"),
  // JSON string arrays; parsed via repoAutomation(). Only trusted reviewers'
  // feedback is acted on; ignored bots are never acted on.
  trustedReviewers: text("trusted_reviewers").notNull().default("[]"),
  ignoredBots: text("ignored_bots")
    .notNull()
    .default('["dependabot[bot]","github-actions[bot]","codecov[bot]"]'),
  // JSON string arrays; parsed via repoAutomation(). Any ready label triggers,
  // any blocking label vetoes; triage may only apply whitelisted labels.
  readyLabels: text("ready_labels")
    .notNull()
    .default('["ready","ready-for-agent","ready-to-work"]'),
  blockingLabels: text("blocking_labels")
    .notNull()
    .default(
      '["blocked","question","needs-human","needs-discussion","wontfix","duplicate","invalid"]',
    ),
  autoLabelWhitelist: text("auto_label_whitelist")
    .notNull()
    .default('["bug","enhancement","documentation","ready"]'),
  priorityAuthors: text("priority_authors").notNull().default("[]"),
  // "approved" = only owners/members/collaborators; "any" = anyone (public).
  minAuthorAssociation: text("min_author_association").notNull().default("approved"),
  maxAttempts: integer("max_attempts").notNull().default(3),
  // Optional per-repo wall-clock session timeout in minutes (issue #47). Null
  // falls back to the global settings.maxJobMinutes default.
  maxJobMinutes: integer("max_job_minutes"),
  // Optional per-repo wall-clock CI wait budget in minutes (issue #52). Null
  // falls back to the global settings.maxCiWaitMinutes default.
  maxCiWaitMinutes: integer("max_ci_wait_minutes"),
  // Optional per-repo per-job USD cost ceiling (issue #57). Null falls back to
  // the global settings.maxJobCostUsd default; 0 disables the ceiling entirely.
  maxJobCostUsd: real("max_job_cost_usd"),
  // Free-text per-repo agent instructions (issue #56). Injected into the work
  // prompt as a dedicated, length-capped section. Null/empty leaves the prompt
  // unchanged. See src/lib/repos/agent-instructions.ts for the cap and rendering.
  agentInstructions: text("agent_instructions"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const promptTemplates = sqliteTable("prompt_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").references(() => repos.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    issueNumber: integer("issue_number").notNull(),
    status: text("status").notNull().default("queued"),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    sessionId: text("session_id"),
    agent: text("agent").notNull().default("claude"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    model: text("model"),
    maxTurns: integer("max_turns").notNull().default(40),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    ciRetryCount: integer("ci_retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    // Lease-based queue (issue #23). A claimed job carries a lease token held by
    // exactly one worker; heartbeats push leaseExpiresAt forward. attempts counts
    // claims (for backoff/maxAttempts), availableAt gates when a deferred/backed-off
    // job becomes claimable, and dedupeKey prevents enqueuing the same work twice.
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    workerId: text("worker_id"),
    availableAt: integer("available_at"),
    dedupeKey: text("dedupe_key"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    repoIdx: index("jobs_repo_idx").on(t.repoId),
    statusIdx: index("jobs_status_idx").on(t.status),
    leaseIdx: index("jobs_lease_idx").on(t.leaseExpiresAt),
    // A dedupe key may be reused once its prior job reaches a terminal state, so
    // uniqueness is scoped to live (non-terminal) jobs via a partial index.
    dedupeActiveUnique: uniqueIndex("jobs_dedupe_active_unique")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} not in ('merged', 'aborted')`),
  }),
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    ts: integer("ts").notNull().default(sql`(unixepoch())`),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
  },
  (t) => ({
    jobTsIdx: index("job_events_job_ts_idx").on(t.jobId, t.ts),
  }),
);

export const adrs = sqliteTable("adrs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
  repoId: integer("repo_id").references(() => repos.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("pending_review"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const followupIssues = sqliteTable("followup_issues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
  ghIssueNumber: integer("gh_issue_number").notNull(),
  title: text("title").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const issues = sqliteTable(
  "issues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    labels: text("labels").notNull().default("[]"),
    state: text("state").notNull().default("open"),
    priority: integer("priority").notNull().default(0),
    // Auto-triage bookkeeping: a content hash of the last triaged version and
    // when it ran. Lets the triage stage skip unchanged issues (ADR 016).
    triageHash: text("triage_hash"),
    triagedAt: integer("triaged_at"),
    // Decomposition bookkeeping (ADR 020): a content hash of the issue body the
    // last time it was decomposed. Lets the decomposer skip an unchanged issue
    // (and avoid re-running the agent fallback) until its body actually changes.
    decomposedHash: text("decomposed_hash"),
    syncedAt: integer("synced_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    repoNumberUnique: uniqueIndex("issues_repo_number_unique").on(t.repoId, t.number),
    repoPriorityIdx: index("issues_repo_priority_idx").on(t.repoId, t.priority),
  }),
);

/**
 * One CI auto-heal session, bound to a job's PR at a specific head SHA (ADR
 * 017). When the PR head moves, the in-flight session is marked `superseded`
 * and a fresh one is opened for the new SHA. `status` is a HealingStatus.
 */
export const healingSessions = sqliteTable(
  "healing_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status").notNull().default("triaging"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    jobIdx: index("healing_sessions_job_idx").on(t.jobId),
    prShaIdx: index("healing_sessions_pr_sha_idx").on(t.prNumber, t.headSha),
  }),
);

/**
 * One heal attempt within a session: the classified failure it targeted, its
 * fingerprint (for per-fingerprint budgeting), the head SHA before/after the
 * agent ran, and the verified outcome. `status`: repairing | healed | rejected.
 */
export const healingAttempts = sqliteTable(
  "healing_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => healingSessions.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    category: text("category").notNull(),
    checkName: text("check_name").notNull(),
    status: text("status").notNull().default("repairing"),
    beforeSha: text("before_sha"),
    afterSha: text("after_sha"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    sessionIdx: index("healing_attempts_session_idx").on(t.sessionId),
    fingerprintIdx: index("healing_attempts_fingerprint_idx").on(t.sessionId, t.fingerprint),
  }),
);

/**
 * One PR review-feedback item (issue #18): a single review thread from a
 * trusted reviewer that Drydock tracks through the feedback lifecycle. The
 * `(jobId, threadId)` pair is unique so a thread re-seen on a later sweep
 * reuses its row and current `status` (a FeedbackStatus). `classification` is
 * actionable | question | out_of_scope; `attempts` counts agent fix attempts.
 */
export const reviewFeedbackItems = sqliteTable(
  "review_feedback_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    threadId: text("thread_id").notNull(),
    reviewer: text("reviewer").notNull(),
    classification: text("classification").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    detail: text("detail"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    jobIdx: index("review_feedback_job_idx").on(t.jobId),
    jobThreadUnique: uniqueIndex("review_feedback_job_thread_unique").on(t.jobId, t.threadId),
  }),
);

/**
 * One ordered subtask of a decomposed issue (issue #19). A large issue is split
 * into subtasks worked in `ordinal` order; `status` is a SubtaskStatus. The
 * `(repoId, issueNumber, ordinal)` triple is unique so a re-decomposition
 * deterministically refreshes the set. `bodyHash` records the source issue body
 * the subtask was derived from, so a changed issue triggers a redo.
 */
export const issueSubtasks = sqliteTable(
  "issue_subtasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    issueNumber: integer("issue_number").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("pending"),
    bodyHash: text("body_hash").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    issueIdx: index("issue_subtasks_issue_idx").on(t.repoId, t.issueNumber),
    issueOrdinalUnique: uniqueIndex("issue_subtasks_issue_ordinal_unique").on(
      t.repoId,
      t.issueNumber,
      t.ordinal,
    ),
  }),
);

/**
 * One post-merge deployment-healing session (issue #20), bound to a job's
 * merged PR at a specific commit SHA. `status` is a DeploymentHealingStatus;
 * `platform` is the deployment platform id. On a failed deployment the captured
 * `logsExcerpt` seeds the follow-up fix PR recorded in `followupPrNumber`.
 * `(jobId, commitSha)` is unique so a merge is monitored exactly once.
 */
export const deploymentHealingSessions = sqliteTable(
  "deployment_healing_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    platform: text("platform").notNull(),
    commitSha: text("commit_sha").notNull(),
    status: text("status").notNull().default("monitoring"),
    logsExcerpt: text("logs_excerpt"),
    followupPrNumber: integer("followup_pr_number"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    jobIdx: index("deployment_healing_job_idx").on(t.jobId),
    jobShaUnique: uniqueIndex("deployment_healing_job_sha_unique").on(t.jobId, t.commitSha),
  }),
);

/**
 * One free-text question asked about a specific PR (issue #55), answered by a
 * read-only QA agent over an assembled context bundle. `status` is a
 * PrQuestionStatus (answering → answered | error); `answer` holds the agent's
 * reply once answered and `errorMessage` the reason on failure (including an
 * empty agent response). Scoped to the job's PR via `(jobId, prNumber)` so
 * answers never leak across PRs. Cascades with its job.
 */
export const prQuestions = sqliteTable(
  "pr_questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    question: text("question").notNull(),
    answer: text("answer"),
    status: text("status").notNull().default("answering"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    jobIdx: index("pr_questions_job_idx").on(t.jobId),
  }),
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type Adr = typeof adrs.$inferSelect;
export type PromptTemplate = typeof promptTemplates.$inferSelect;
export type FollowupIssue = typeof followupIssues.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type HealingSession = typeof healingSessions.$inferSelect;
export type NewHealingSession = typeof healingSessions.$inferInsert;
export type HealingAttempt = typeof healingAttempts.$inferSelect;
export type NewHealingAttempt = typeof healingAttempts.$inferInsert;
export type ReviewFeedbackItem = typeof reviewFeedbackItems.$inferSelect;
export type NewReviewFeedbackItem = typeof reviewFeedbackItems.$inferInsert;
export type IssueSubtask = typeof issueSubtasks.$inferSelect;
export type NewIssueSubtask = typeof issueSubtasks.$inferInsert;
export type DeploymentHealingSession = typeof deploymentHealingSessions.$inferSelect;
export type NewDeploymentHealingSession = typeof deploymentHealingSessions.$inferInsert;
export type PrQuestion = typeof prQuestions.$inferSelect;
export type NewPrQuestion = typeof prQuestions.$inferInsert;
