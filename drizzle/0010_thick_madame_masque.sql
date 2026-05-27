CREATE TABLE `issue_subtasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`issue_number` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`body_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_subtasks_issue_idx` ON `issue_subtasks` (`repo_id`,`issue_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_subtasks_issue_ordinal_unique` ON `issue_subtasks` (`repo_id`,`issue_number`,`ordinal`);--> statement-breakpoint
ALTER TABLE `issues` ADD `decomposed_hash` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_decompose` integer DEFAULT false NOT NULL;