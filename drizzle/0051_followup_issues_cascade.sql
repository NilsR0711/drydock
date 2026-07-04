-- Issue #418: followup_issues was the only job-scoped table whose FK used
-- ON DELETE set null. When a repo is removed its jobs cascade away, but the
-- old policy merely nulled followup_issues.job_id. The sole read path filters
-- by job_id, so nulled rows could never be selected again, the prune sweep
-- never touched them, and they accumulated as permanent, unreachable dead data.
--
-- Rebuild the table with ON DELETE cascade so a follow-up row dies with its job
-- (a follow-up is meaningless without it — gh_issue_number is repo-relative).
-- The INSERT copies only job_id IS NOT NULL rows, dropping any already-orphaned
-- rows in the process. The migration runner disables FK enforcement around this
-- transaction and runs `PRAGMA foreign_key_check` before commit, so the DROP
-- TABLE does not fire cascades and a violation would roll the whole thing back.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_followup_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`gh_issue_number` integer NOT NULL,
	`title` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_followup_issues`("id", "job_id", "gh_issue_number", "title", "created_at") SELECT "id", "job_id", "gh_issue_number", "title", "created_at" FROM `followup_issues` WHERE `job_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `followup_issues`;--> statement-breakpoint
ALTER TABLE `__new_followup_issues` RENAME TO `followup_issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
