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
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    repoIdx: index("jobs_repo_idx").on(t.repoId),
    statusIdx: index("jobs_status_idx").on(t.status),
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
    syncedAt: integer("synced_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    repoNumberUnique: uniqueIndex("issues_repo_number_unique").on(t.repoId, t.number),
    repoPriorityIdx: index("issues_repo_priority_idx").on(t.repoId, t.priority),
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
