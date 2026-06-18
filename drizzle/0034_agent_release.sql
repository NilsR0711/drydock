ALTER TABLE `jobs` ADD COLUMN `kind` text DEFAULT 'issue' NOT NULL;--> statement-breakpoint
ALTER TABLE `release_runs` ADD COLUMN `job_id` integer REFERENCES jobs(id) ON DELETE set null;--> statement-breakpoint
DROP INDEX `jobs_dedupe_active_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_active_unique` ON `jobs` (`dedupe_key`) WHERE "jobs"."dedupe_key" is not null and "jobs"."status" not in ('merged', 'released', 'aborted');
