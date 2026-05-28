CREATE TABLE `deployment_healing_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`pr_number` integer NOT NULL,
	`platform` text NOT NULL,
	`commit_sha` text NOT NULL,
	`status` text DEFAULT 'monitoring' NOT NULL,
	`logs_excerpt` text,
	`followup_pr_number` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deployment_healing_job_idx` ON `deployment_healing_sessions` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_healing_job_sha_unique` ON `deployment_healing_sessions` (`job_id`,`commit_sha`);--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_heal_deployments` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `deployment_platform` text;