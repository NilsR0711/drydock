CREATE TABLE `review_feedback_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`pr_number` integer NOT NULL,
	`thread_id` text NOT NULL,
	`reviewer` text NOT NULL,
	`classification` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_feedback_job_idx` ON `review_feedback_items` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_feedback_job_thread_unique` ON `review_feedback_items` (`job_id`,`thread_id`);--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_review_feedback` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_resolve_merge_conflicts` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `include_progress_replies` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `trusted_reviewers` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `ignored_bots` text DEFAULT '["dependabot[bot]","github-actions[bot]","codecov[bot]"]' NOT NULL;