CREATE TABLE `adrs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`file_path` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `followup_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`gh_issue_number` integer NOT NULL,
	`title` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_events_job_ts_idx` ON `job_events` (`job_id`,`ts`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`issue_number` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`branch` text,
	`pr_number` integer,
	`session_id` text,
	`started_at` integer,
	`finished_at` integer,
	`model` text,
	`max_turns` integer DEFAULT 40 NOT NULL,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`ci_retry_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_repo_idx` ON `jobs` (`repo_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`queue_label` text DEFAULT 'drydock:queue' NOT NULL,
	`working_label` text DEFAULT 'drydock:working' NOT NULL,
	`needs_human_label` text DEFAULT 'drydock:needs-human' NOT NULL,
	`default_model` text DEFAULT 'claude-sonnet-4-5' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
