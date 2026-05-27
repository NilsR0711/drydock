ALTER TABLE `repos` ADD `agent` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `agent` text DEFAULT 'claude' NOT NULL;
