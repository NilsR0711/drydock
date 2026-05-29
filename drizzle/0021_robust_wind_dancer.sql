PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`queue_label` text DEFAULT 'drydock:queue' NOT NULL,
	`working_label` text DEFAULT 'drydock:working' NOT NULL,
	`needs_human_label` text DEFAULT 'drydock:needs-human' NOT NULL,
	`default_model` text DEFAULT 'claude-opus-4-8' NOT NULL,
	`agent` text DEFAULT 'claude' NOT NULL,
	`platform` text DEFAULT 'github' NOT NULL,
	`api_base_url` text,
	`api_token` text,
	`daily_cost_limit_usd` real DEFAULT 10 NOT NULL,
	`adr_gating` integer DEFAULT false NOT NULL,
	`sequential` integer DEFAULT true NOT NULL,
	`auto_triage_enabled` integer DEFAULT false NOT NULL,
	`auto_process_enabled` integer DEFAULT false NOT NULL,
	`auto_heal_ci` integer DEFAULT false NOT NULL,
	`auto_review_feedback` integer DEFAULT false NOT NULL,
	`auto_resolve_merge_conflicts` integer DEFAULT false NOT NULL,
	`include_progress_replies` integer DEFAULT false NOT NULL,
	`auto_decompose` integer DEFAULT false NOT NULL,
	`verify_pr` integer DEFAULT false NOT NULL,
	`auto_heal_deployments` integer DEFAULT false NOT NULL,
	`deployment_platform` text,
	`trusted_reviewers` text DEFAULT '[]' NOT NULL,
	`ignored_bots` text DEFAULT '["dependabot[bot]","github-actions[bot]","codecov[bot]"]' NOT NULL,
	`ready_labels` text DEFAULT '["ready","ready-for-agent","ready-to-work"]' NOT NULL,
	`blocking_labels` text DEFAULT '["blocked","question","needs-human","needs-discussion","wontfix","duplicate","invalid"]' NOT NULL,
	`auto_label_whitelist` text DEFAULT '["bug","enhancement","documentation","ready"]' NOT NULL,
	`priority_authors` text DEFAULT '[]' NOT NULL,
	`min_author_association` text DEFAULT 'approved' NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`max_job_minutes` integer,
	`max_ci_wait_minutes` integer,
	`max_job_cost_usd` real,
	`agent_instructions` text,
	`release_enabled` integer DEFAULT false NOT NULL,
	`webhook_secret` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_repos`("id", "path", "name", "default_branch", "queue_label", "working_label", "needs_human_label", "default_model", "agent", "platform", "api_base_url", "api_token", "daily_cost_limit_usd", "adr_gating", "sequential", "auto_triage_enabled", "auto_process_enabled", "auto_heal_ci", "auto_review_feedback", "auto_resolve_merge_conflicts", "include_progress_replies", "auto_decompose", "verify_pr", "auto_heal_deployments", "deployment_platform", "trusted_reviewers", "ignored_bots", "ready_labels", "blocking_labels", "auto_label_whitelist", "priority_authors", "min_author_association", "max_attempts", "max_job_minutes", "max_ci_wait_minutes", "max_job_cost_usd", "agent_instructions", "release_enabled", "webhook_secret", "created_at") SELECT "id", "path", "name", "default_branch", "queue_label", "working_label", "needs_human_label", "default_model", "agent", "platform", "api_base_url", "api_token", "daily_cost_limit_usd", "adr_gating", "sequential", "auto_triage_enabled", "auto_process_enabled", "auto_heal_ci", "auto_review_feedback", "auto_resolve_merge_conflicts", "include_progress_replies", "auto_decompose", "verify_pr", "auto_heal_deployments", "deployment_platform", "trusted_reviewers", "ignored_bots", "ready_labels", "blocking_labels", "auto_label_whitelist", "priority_authors", "min_author_association", "max_attempts", "max_job_minutes", "max_ci_wait_minutes", "max_job_cost_usd", "agent_instructions", "release_enabled", "webhook_secret", "created_at" FROM `repos`;--> statement-breakpoint
DROP TABLE `repos`;--> statement-breakpoint
ALTER TABLE `__new_repos` RENAME TO `repos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;