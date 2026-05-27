ALTER TABLE `repos` ADD `platform` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `api_base_url` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `api_token` text;