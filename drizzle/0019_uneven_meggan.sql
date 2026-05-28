CREATE TABLE `release_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`trigger_pr_number` integer,
	`trigger_sha` text,
	`status` text DEFAULT 'detected' NOT NULL,
	`bump` text,
	`from_tag` text,
	`tag` text,
	`title` text,
	`notes` text,
	`pr_numbers` text DEFAULT '[]' NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `release_runs_repo_idx` ON `release_runs` (`repo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_runs_trigger_unique` ON `release_runs` (`repo_id`,`trigger_sha`) WHERE "release_runs"."trigger_sha" is not null;--> statement-breakpoint
ALTER TABLE `repos` ADD `release_enabled` integer DEFAULT false NOT NULL;