ALTER TABLE `adrs` ADD `repo_id` integer REFERENCES repos(id);--> statement-breakpoint
ALTER TABLE `repos` ADD `daily_cost_limit_usd` real DEFAULT 10 NOT NULL;