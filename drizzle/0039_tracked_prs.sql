CREATE TABLE `tracked_prs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_number` integer NOT NULL,
	`url` text NOT NULL,
	`platform` text NOT NULL,
	`branch` text,
	`head_slug` text,
	`base_slug` text,
	`is_fork` integer DEFAULT false NOT NULL,
	`owned` integer DEFAULT false NOT NULL,
	`auto_merge` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'tracking' NOT NULL,
	`title` text,
	`author` text,
	`head_sha` text,
	`ci_retry_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tracked_prs_repo_idx` ON `tracked_prs` (`repo_id`);--> statement-breakpoint
CREATE INDEX `tracked_prs_status_idx` ON `tracked_prs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_prs_repo_pr_unique` ON `tracked_prs` (`repo_id`,`pr_number`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_review_feedback_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`tracked_pr_id` integer,
	`pr_number` integer NOT NULL,
	`thread_id` text NOT NULL,
	`reviewer` text NOT NULL,
	`classification` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracked_pr_id`) REFERENCES `tracked_prs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_review_feedback_items`("id", "job_id", "tracked_pr_id", "pr_number", "thread_id", "reviewer", "classification", "status", "attempts", "detail", "created_at", "updated_at") SELECT "id", "job_id", NULL, "pr_number", "thread_id", "reviewer", "classification", "status", "attempts", "detail", "created_at", "updated_at" FROM `review_feedback_items`;--> statement-breakpoint
DROP TABLE `review_feedback_items`;--> statement-breakpoint
ALTER TABLE `__new_review_feedback_items` RENAME TO `review_feedback_items`;--> statement-breakpoint
CREATE INDEX `review_feedback_job_idx` ON `review_feedback_items` (`job_id`);--> statement-breakpoint
CREATE INDEX `review_feedback_tracked_idx` ON `review_feedback_items` (`tracked_pr_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_feedback_job_thread_unique` ON `review_feedback_items` (`job_id`,`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_feedback_tracked_thread_unique` ON `review_feedback_items` (`tracked_pr_id`,`thread_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
