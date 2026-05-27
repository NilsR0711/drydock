ALTER TABLE `issues` ADD `triage_hash` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `triaged_at` integer;--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_triage_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_process_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `ready_labels` text DEFAULT '["ready","ready-for-agent","ready-to-work"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `blocking_labels` text DEFAULT '["blocked","question","needs-human","needs-discussion","wontfix","duplicate","invalid"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `auto_label_whitelist` text DEFAULT '["bug","enhancement","documentation","ready"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `priority_authors` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `min_author_association` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `max_attempts` integer DEFAULT 3 NOT NULL;