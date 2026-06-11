CREATE TABLE `openrouter_models` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`context_length` integer NOT NULL DEFAULT 0,
	`prompt_cost_per_token` real NOT NULL DEFAULT 0,
	`completion_cost_per_token` real NOT NULL DEFAULT 0,
	`supported_parameters` text NOT NULL DEFAULT '[]',
	`expiration_date` integer,
	`is_free` integer NOT NULL DEFAULT 0,
	`supports_tools` integer NOT NULL DEFAULT 0,
	`removed_at` integer,
	`synced_at` integer NOT NULL DEFAULT (unixepoch())
);--> statement-breakpoint
CREATE INDEX `openrouter_models_free_idx` ON `openrouter_models` (`is_free`);--> statement-breakpoint
CREATE INDEX `openrouter_models_removed_idx` ON `openrouter_models` (`removed_at`);
