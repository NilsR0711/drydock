ALTER TABLE `repos` ADD COLUMN `auto_pr_audit` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `pr_audit_agent` text;--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `pr_audit_model` text;--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `pr_audit_language` text NOT NULL DEFAULT 'en';--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `pr_audit_post_on_pr` integer NOT NULL DEFAULT 0;
