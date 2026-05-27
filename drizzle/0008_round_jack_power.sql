CREATE TABLE `healing_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`category` text NOT NULL,
	`check_name` text NOT NULL,
	`status` text DEFAULT 'repairing' NOT NULL,
	`before_sha` text,
	`after_sha` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `healing_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `healing_attempts_session_idx` ON `healing_attempts` (`session_id`);--> statement-breakpoint
CREATE INDEX `healing_attempts_fingerprint_idx` ON `healing_attempts` (`session_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `healing_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`status` text DEFAULT 'triaging' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `healing_sessions_job_idx` ON `healing_sessions` (`job_id`);--> statement-breakpoint
CREATE INDEX `healing_sessions_pr_sha_idx` ON `healing_sessions` (`pr_number`,`head_sha`);--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_heal_ci` integer DEFAULT false NOT NULL;