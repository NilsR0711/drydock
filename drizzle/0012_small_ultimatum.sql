ALTER TABLE `jobs` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `worker_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `available_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dedupe_key` text;--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `jobs` (`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_active_unique` ON `jobs` (`dedupe_key`) WHERE "jobs"."dedupe_key" is not null and "jobs"."status" not in ('merged', 'aborted');