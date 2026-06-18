-- issue #213: default review feedback ON for autonomous operation.
-- Backfill existing repos that still hold the legacy defaults; rows already
-- customized by the user are matched out and left untouched.
UPDATE `repos` SET `auto_review_feedback` = 1 WHERE `auto_review_feedback` = 0;
--> statement-breakpoint
UPDATE `repos` SET `trusted_bots` = '["cursor[bot]","coderabbitai[bot]"]' WHERE `trusted_bots` = '[]';
