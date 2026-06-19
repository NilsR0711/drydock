-- Issue #317: the PR audit is now posted canonically on the PR itself. The old
-- `pr_audit_post_on_pr` flag (an opt-in PR mirror on top of the issue comment)
-- is replaced by `pr_audit_post_on_issue` (an opt-in issue mirror on top of the
-- PR comment). The semantics invert, so the column is dropped and re-added at
-- the new default (off) rather than renamed — a prior PR-mirror opt-in must not
-- silently become an issue-mirror opt-in.
ALTER TABLE `repos` DROP COLUMN `pr_audit_post_on_pr`;--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `pr_audit_post_on_issue` integer NOT NULL DEFAULT 0;
