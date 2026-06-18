ALTER TABLE `repos` ADD COLUMN `sandbox` text NOT NULL DEFAULT 'none';--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `sandbox_image` text;--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `sandbox_allow_network` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `sandbox_cpus` text;--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `sandbox_memory` text;
