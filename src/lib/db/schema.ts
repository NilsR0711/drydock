import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable("repos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  queueLabel: text("queue_label").notNull().default("autoclaude:queue"),
  workingLabel: text("working_label").notNull().default("autoclaude:working"),
  needsHumanLabel: text("needs_human_label").notNull().default("autoclaude:needs-human"),
  defaultModel: text("default_model").notNull().default("claude-sonnet-4-5"),
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
