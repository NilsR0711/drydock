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
  defaultModel: text("default_model").notNull().default("claude-opus-4-8"),
  agent: text("agent").notNull().default("claude"),
  platform: text("platform").notNull().default("github"),
  apiBaseUrl: text("api_base_url"),
  apiToken: text("api_token"),
  // Per-repo daily USD budget. 0 is off (unlimited), like the global default
  // and the per-job cap (issue #234). Defaults to 0 so a new repo is fully
  // autonomous out of the box (issue #254). New rows seed from repoInputSchema;
  // existing rows keep their stored value and are intentionally not backfilled.
  dailyCostLimitUsd: real("daily_cost_limit_usd").notNull().default(0),
  adrGating: integer("adr_gating", { mode: "boolean" }).notNull().default(false),
  sequential: integer("sequential", { mode: "boolean" }).notNull().default(true),
  // Backlog-driving automation is opt-in (issue #285): default OFF so a freshly
  // added repo does nothing to its whole backlog until the user turns these on
  // per repo. Default-on (the legacy #254 posture) meant registering a repo
  // could silently auto-triage and mass-enqueue every `ready` issue in a single
  // tick. A `schema.ts` default change only affects new rows; existing repos
  // keep their stored value. Kept in sync with repoInputSchema. See ADR 016.
  autoTriageEnabled: integer("auto_triage_enabled", { mode: "boolean" }).notNull().default(false),
  autoProcessEnabled: integer("auto_process_enabled", { mode: "boolean" }).notNull().default(false),
  // CI auto-healing on by default for autonomous operation (issue #254). See ADR 017.
  autoHealCi: integer("auto_heal_ci", { mode: "boolean" }).notNull().default(true),
  // PR review-feedback lifecycle (ADR 019). Defaults ON for autonomous
  // operation (issue #213): an issue-to-PR tool should act on review-bot
  // findings out of the box. Still bounded (per-sweep/per-item budgets, never
  // auto-merges) and opt-out per repo. The 0032 migration backfills existing
  // repos that still hold the legacy `false` default.
  autoReviewFeedback: integer("auto_review_feedback", { mode: "boolean" }).notNull().default(true),
  // Bounded merge-conflict repair within the feedback loop. On by default for
  // autonomous operation (issue #254); still bounded and opt-out per repo.
  autoResolveMergeConflicts: integer("auto_resolve_merge_conflicts", { mode: "boolean" })
    .notNull()
    .default(true),
  // Post incremental "working on it" replies (default off, to avoid noise).
  includeProgressReplies: integer("include_progress_replies", { mode: "boolean" })
    .notNull()
    .default(false),
  // Decomposition of large issues into tracked subtasks. Opt-in (issue #285):
  // it fires slow `claude -p` one-shots across the backlog and can stall the
  // driver loop, so default OFF. Only affects new rows. See ADR 020.
  autoDecompose: integer("auto_decompose", { mode: "boolean" }).notNull().default(false),
  // Opt-in plan-first stage (issue #160, default off). Before the implementation
  // session, a read-only one-shot pass produces an implementation plan that is
  // posted on the issue and embedded in the work prompt. Best-effort: any plan
  // failure falls back to the normal single-stage run.
  planFirst: integer("plan_first", { mode: "boolean" }).notNull().default(false),
  // Post-PR verification pass, on by default for autonomous operation (issue
  // #254). See ADR 027. After a PR is opened, a read-only one-shot agent checks
  // whether the diff satisfies the issue and its subtasks; the result updates
  // subtask status and surfaces a summary. Never auto-merges and never corrupts
  // state on failure.
  verifyPr: integer("verify_pr", { mode: "boolean" }).notNull().default(true),
  // Opt-in post-merge deployment healing (default off). See ADR 021. When a
  // monitored deployment fails, a follow-up fix PR is opened with the logs.
  autoHealDeployments: integer("auto_heal_deployments", { mode: "boolean" })
    .notNull()
    .default(false),
  // Explicit deployment-platform override (e.g. "vercel"/"railway"). Null lets
  // Drydock auto-detect the platform from the repo's config files.
  deploymentPlatform: text("deployment_platform"),
  // JSON string arrays; parsed via repoAutomation(). Only trusted reviewers'
  // feedback is acted on. Bot accounts ([bot] logins) are ignored unless
  // explicitly allowlisted in trustedBots; ignored bots are never acted on.
  trustedReviewers: text("trusted_reviewers").notNull().default("[]"),
  // Well-known review bots trusted by default (issue #213) so review feedback
  // is acted on out of the box; empty allowlists otherwise leave the loop inert.
  trustedBots: text("trusted_bots").notNull().default('["cursor[bot]","coderabbitai[bot]"]'),
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
  // Review settle gate in minutes (issue #159, default 0 = merge immediately).
  // After CI first goes all-green the babysitter keeps polling for this long
  // before merging, so late bot/human reviews (e.g. cursor[bot]) can land and
  // feed the review-feedback loop instead of arriving on a merged PR. Any
  // regression to pending/failed during the window resets the gate.
  mergeGateMinutes: integer("merge_gate_minutes").notNull().default(0),
  // Opt-in: auto-merge a PR that reports no CI checks at all (issue #207,
  // default off). Repos with manual-only (workflow_dispatch) CI or that rely
  // solely on review bots report zero checks, so the babysitter would otherwise
  // wait out the CI budget and escalate to needs_human. When on, the babysitter
  // confirms the absence across the merge-gate settle window and then merges
  // with NO automated verification. Off by default — absent CI means absent
  // verification, so this must be opted into per repo.
  mergeWithoutChecks: integer("merge_without_checks", { mode: "boolean" }).notNull().default(false),
  // Optional per-repo per-job USD cost ceiling (issue #57). Null falls back to
  // the global settings.maxJobCostUsd default; 0 disables the ceiling entirely.
  maxJobCostUsd: real("max_job_cost_usd"),
  // Free-text per-repo agent instructions (issue #56). Injected into the work
  // prompt as a dedicated, length-capped section. Null/empty leaves the prompt
  // unchanged. See src/lib/repos/agent-instructions.ts for the cap and rendering.
  agentInstructions: text("agent_instructions"),
  // Opt-in release management (issue #59, default off). See ADR 028. When on (and
  // the global kill-switch is also on), merged PRs trigger an evaluate → version
  // → publish release pipeline. Cutting a public release is hard to reverse, so
  // it is gated globally and per repo and is fully previewable.
  releaseEnabled: integer("release_enabled", { mode: "boolean" }).notNull().default(false),
  // Opt-in webhook-driven issue sync (issue #61). See ADR 029. A non-empty
  // secret enables the inbound receiver at /api/webhooks/<repoId>: it verifies
  // each delivery (GitHub HMAC-SHA256 signature / GitLab token) and triggers a
  // targeted, debounced sync for this repo. Null/empty leaves polling as the
  // sole sync path; the secret doubles as the per-repo opt-in switch.
  webhookSecret: text("webhook_secret"),
  // AI PR audit (issue #168), opt-in/off by default (issue #316). A read-only,
  // whole-PR review (Bugbot/CodeRabbit style) runs after a PR opens and is
  // posted on the issue as an idempotent comment. It defaults OFF so a repo that
  // already runs an external reviewer doesn't pay for a second whole-PR review
  // by accident; a repo opts in explicitly. Agent/model null inherits the repo's
  // agent and defaultModel; the language is a simple/BCP 47 code, English by default.
  autoPrAudit: integer("auto_pr_audit", { mode: "boolean" }).notNull().default(false),
  prAuditAgent: text("pr_audit_agent"),
  prAuditModel: text("pr_audit_model"),
  prAuditLanguage: text("pr_audit_language").notNull().default("en"),
  // The audit is posted canonically on the PR itself (issue #317). This opt-in
  // flag additionally mirrors it onto the issue; off by default.
  prAuditPostOnIssue: integer("pr_audit_post_on_issue", { mode: "boolean" })
    .notNull()
    .default(false),
  // Opt-in auto-fix of the AI PR audit's own findings (issue #318, default off).
  // Only meaningful when autoPrAudit is also on: when set, the agent revises the
  // diff to address its high-severity findings (blocker/major) and pushes a
  // follow-up commit to the PR branch — no external review bot required. The fix
  // commit re-triggers CI and goes through the normal merge gate; a self-review
  // never shortcuts the merge. Bounded by the review-feedback budgets and
  // idempotent across repeated audit runs.
  autoPrAuditFix: integer("auto_pr_audit_fix", { mode: "boolean" }).notNull().default(false),
  // Opt-in model escalation ladder (issue #179, default off). When a failed
  // (needs_human) job is requeued, the next attempt runs the next-stronger
  // model in the agent's catalog ladder, capped at the strongest model. The
  // escalated model is persisted on the job so pricing reflects the actual run.
  escalateModelOnRetry: integer("escalate_model_on_retry", { mode: "boolean" })
    .notNull()
    .default(false),
  // Opt-in sandboxed agent execution (issue #182, ADR 033, default "none"). When
  // "docker", the repo's agent CLI sessions run inside a container with the
  // worktree bind-mounted as the only writable host path. `sandboxImage` is an
  // explicit per-repo image override (null → devcontainer.json, else the global
  // settings.sandboxDefaultImage). Network is off by default; CPU/memory caps are
  // optional. Off by default — zero behavior change for existing repos.
  sandbox: text("sandbox").notNull().default("none"),
  sandboxImage: text("sandbox_image"),
  sandboxAllowNetwork: integer("sandbox_allow_network", { mode: "boolean" })
    .notNull()
    .default(false),
  sandboxCpus: text("sandbox_cpus"),
  sandboxMemory: text("sandbox_memory"),
  // Opt-in claude-mem worktree adoption (issue #274, default off). When on, a
  // settling job triggers claude-mem's `adopt` for its worktree right before
  // Drydock removes it, consolidating the per-worktree memory into the parent
  // project while the worktree still exists. Best-effort and depends on the
  // external claude-mem plugin being installed, so it is off by default.
  adoptClaudeMem: integer("adopt_claude_mem", { mode: "boolean" }).notNull().default(false),
  // Quiet mode for the issue thread (issue #289, default off). When on, the
  // purely-informational lifecycle comments — the auto-triage "applied labels"
  // note and the post-PR verification summary — are suppressed (the labels and
  // subtask status they mirror are visible on the issue anyway). High-signal,
  // human-actionable comments (PR audit, needs-human, merge-conflict park) are
  // never silenced. Off by default, so existing repos keep the full audit trail.
  quietComments: integer("quiet_comments", { mode: "boolean" }).notNull().default(false),
  // Opt-in unrestricted shell access (issue #283, default off). When on, this
  // repo's agent jobs run with `--dangerously-skip-permissions` instead of the
  // default edits-only `acceptEdits` mode, so the headless agent can execute any
  // Bash command (e.g. `xcodebuild`/`simctl` for native Xcode repos that can't
  // run in a Docker sandbox). This is a deliberately dangerous escape hatch —
  // it grants the agent full shell access — so it is off by default and only
  // affects new rows; existing repos keep their stored value.
  bypassPermissions: integer("bypass_permissions", { mode: "boolean" }).notNull().default(false),
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
    // Discriminates the job's flow (issue #256): "issue" runs the
    // implement→PR→CI→merge pipeline; "release" runs an agent-driven release in
    // its own runner. Release jobs carry the sentinel issueNumber 0 — `kind` is
    // the source of truth, so issueNumber stays NOT NULL (no nullable blast
    // radius across the issue-flow code).
    kind: text("kind").notNull().default("issue"),
    issueNumber: integer("issue_number").notNull(),
    status: text("status").notNull().default("queued"),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    sessionId: text("session_id"),
    agent: text("agent").notNull().default("claude"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    model: text("model"),
    // Resolved version of the repo's "default" (implement) prompt template at
    // spawn time (issue #178). Null when the run used the code-level default
    // template (no saved repo version). Lets analytics slice outcomes by the
    // exact prompt revision a job ran with, alongside model and agent.
    implementPromptVersion: integer("implement_prompt_version"),
    // Per-job turn budget; 0 means unlimited (issue #254). The effective default
    // for new jobs comes from the global maxTurns setting (createJob always seeds
    // an explicit value), so this column default is dead for real inserts — it
    // stays at the frozen migration value (40) to avoid a no-op SQLite table
    // rebuild just to realign a fallback that is never hit.
    maxTurns: integer("max_turns").notNull().default(40),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    ciRetryCount: integer("ci_retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    // Provider-limit park marker (issue #166, ADR 030): the ProviderLimitKind
    // that parked this job in `waiting_limit`. A set value plus a recorded
    // sessionId makes the next run resume the session (`--resume`) instead of
    // starting from scratch; cleared when the run restarts.
    limitKind: text("limit_kind"),
    // Human guidance for a needs_human job the operator unblocked by typing
    // instructions (issue #257). A set value plus a recorded sessionId makes the
    // next run resume the stored session with this text as the prompt — on the
    // job's preserved branch when one was pushed at park time — so the agent
    // continues its prior work with the guidance instead of retrying blind.
    // Cleared when the run restarts.
    humanInstruction: text("human_instruction"),
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
      .where(
        sql`${t.dedupeKey} is not null and ${t.status} not in ('merged', 'released', 'aborted')`,
      ),
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
    // Per-issue model/agent override (issue #101). When set, the driver loop
    // uses these instead of the repo defaults when enqueuing the job.
    modelOverride: text("model_override"),
    agentOverride: text("agent_override"),
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
    // A feedback item belongs to EITHER an issue→PR job OR a URL-tracked PR
    // (issue #293): exactly one of these is set. jobId became nullable so the
    // review-feedback lifecycle can be reused against externally-authored PRs
    // that have no originating job. The service layer enforces the xor.
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    trackedPrId: integer("tracked_pr_id").references(() => trackedPrs.id, { onDelete: "cascade" }),
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
    trackedIdx: index("review_feedback_tracked_idx").on(t.trackedPrId),
    // A thread is unique within its owner. NULLs are distinct in SQLite, so the
    // job-owned and tracked-PR-owned rows never collide across the two indexes.
    jobThreadUnique: uniqueIndex("review_feedback_job_thread_unique").on(t.jobId, t.threadId),
    trackedThreadUnique: uniqueIndex("review_feedback_tracked_thread_unique").on(
      t.trackedPrId,
      t.threadId,
    ),
  }),
);

/**
 * A pull request Drydock babysits independently of any issue→PR job (issue
 * #293). An operator adds an existing PR by URL; from then on Drydock watches
 * its CI, runs review-feedback, heals/merges (when the branch is ours and
 * auto-merge is opted in) and hands off to a human otherwise. Decoupled from
 * `jobs`/`issues` on purpose: a tracked PR may be authored by anyone and live
 * regardless of whether the repo's issues are watched.
 */
export const trackedPrs = sqliteTable(
  "tracked_prs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    url: text("url").notNull(),
    platform: text("platform").notNull(),
    // Head branch name; null until the first reconciliation fills it in.
    branch: text("branch"),
    // `owner/name` of the head and base repositories. A head that differs from
    // base is a fork PR: we cannot push fixes to it, so heal/auto-merge are
    // disabled and review-feedback that needs an edit escalates to a human.
    headSlug: text("head_slug"),
    baseSlug: text("base_slug"),
    isFork: integer("is_fork", { mode: "boolean" }).notNull().default(false),
    // True when the branch lives in the base repo AND carries our `drydock/`
    // prefix — the only case the branch janitor may ever delete/force-update.
    owned: integer("owned", { mode: "boolean" }).notNull().default(false),
    // Off by default (issue #293): externally-authored PRs are never merged
    // unless an operator opts this PR in. Even then we only merge our own
    // branches with a clean merge state.
    autoMerge: integer("auto_merge", { mode: "boolean" }).notNull().default(false),
    // tracking | needs_human | merged | closed | stopped (see tracked-prs/service).
    status: text("status").notNull().default("tracking"),
    title: text("title"),
    author: text("author"),
    headSha: text("head_sha"),
    ciRetryCount: integer("ci_retry_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    repoIdx: index("tracked_prs_repo_idx").on(t.repoId),
    statusIdx: index("tracked_prs_status_idx").on(t.status),
    repoPrUnique: uniqueIndex("tracked_prs_repo_pr_unique").on(t.repoId, t.prNumber),
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

/**
 * One release run (issue #59), the unit Drydock tracks through the release
 * pipeline. A run is created when a release is detected — a merged PR (auto mode)
 * or a manual publish trigger (manual mode) — and walks a ReleaseStatus:
 * `detected → evaluating → proposed → publishing → published | skipped | error`.
 * Idempotency: the auto path dedupes on `(repoId, triggerSha)` so one merge
 * commit yields exactly one run; manual runs carry a null `triggerSha`. `bump`,
 * `fromTag`, and `tag` capture the computed version, `prNumbers` the included
 * PRs (JSON array), and `errorMessage` the reason on a failed run.
 */
export const releaseRuns = sqliteTable(
  "release_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    // "auto" (triggered by a merged PR) or "manual" (operator-forced publish),
    // both deterministic; or "agent" (issue #256), an agent-driven release run
    // backed by a job whose live log streams the agent's release steps.
    mode: text("mode").notNull().default("auto"),
    // The job that executes an agent-driven release (mode "agent", issue #256);
    // null for deterministic auto/manual runs. Lets the panel deep-link to the
    // job's live log.
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
    // The merged PR and its merge commit SHA that triggered an auto run; both
    // null for a manual run. The SHA dedupes auto runs (one run per merge).
    triggerPrNumber: integer("trigger_pr_number"),
    triggerSha: text("trigger_sha"),
    status: text("status").notNull().default("detected"),
    // The chosen semver bump and the from/to tags, filled in during evaluation.
    bump: text("bump"),
    fromTag: text("from_tag"),
    tag: text("tag"),
    title: text("title"),
    notes: text("notes"),
    // JSON array of the PR numbers included in this release.
    prNumbers: text("pr_numbers").notNull().default("[]"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    repoIdx: index("release_runs_repo_idx").on(t.repoId),
    // One auto run per merge commit: dedupe on (repoId, triggerSha) for runs that
    // carry a SHA (manual runs have a null SHA and never collide).
    triggerUnique: uniqueIndex("release_runs_trigger_unique")
      .on(t.repoId, t.triggerSha)
      .where(sql`${t.triggerSha} is not null`),
  }),
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Cost ledger for one-shot agent calls that are not bound to a job: issue
 * decomposition sweeps and release evaluation runs (issue #95). These calls
 * spawn a real agent CLI but have no originating job, so their spend is
 * recorded here and folded into `todayCost`/`dailyCosts` alongside job spend.
 */
export const oneShotCosts = sqliteTable(
  "one_shot_costs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** The driver that made the call: "decompose" | "release". */
    type: text("type").notNull(),
    costUsd: real("cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    repoIdx: index("one_shot_costs_repo_idx").on(t.repoId),
  }),
);

export type OneShotCost = typeof oneShotCosts.$inferSelect;
export type NewOneShotCost = typeof oneShotCosts.$inferInsert;

/**
 * Local mirror of the OpenRouter model catalog (issue #169). Synced from
 * `GET /api/v1/models` on an interval; rows for models that disappear from the
 * API are soft-deleted via `removedAt` so historical jobs keep their labels.
 * Pricing is stored as USD per token, exactly as the API reports it.
 */
export const openrouterModels = sqliteTable(
  "openrouter_models",
  {
    /** OpenRouter model id, e.g. "meta-llama/llama-3.3-70b-instruct:free". */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    contextLength: integer("context_length").notNull().default(0),
    promptCostPerToken: real("prompt_cost_per_token").notNull().default(0),
    completionCostPerToken: real("completion_cost_per_token").notNull().default(0),
    /** JSON array of supported request parameters (e.g. ["tools","max_tokens"]). */
    supportedParameters: text("supported_parameters").notNull().default("[]"),
    /** Epoch seconds after which OpenRouter retires the model; null = no sunset. */
    expirationDate: integer("expiration_date"),
    isFree: integer("is_free", { mode: "boolean" }).notNull().default(false),
    supportsTools: integer("supports_tools", { mode: "boolean" }).notNull().default(false),
    /** Epoch seconds when the model vanished from the API; null = still listed. */
    removedAt: integer("removed_at"),
    syncedAt: integer("synced_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    freeIdx: index("openrouter_models_free_idx").on(t.isFree),
    removedIdx: index("openrouter_models_removed_idx").on(t.removedAt),
  }),
);

export type OpenRouterModel = typeof openrouterModels.$inferSelect;

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
export type ReleaseRun = typeof releaseRuns.$inferSelect;
export type NewReleaseRun = typeof releaseRuns.$inferInsert;
export type TrackedPr = typeof trackedPrs.$inferSelect;
export type NewTrackedPr = typeof trackedPrs.$inferInsert;
