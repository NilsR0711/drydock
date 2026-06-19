-- issue #316: the AI PR audit becomes opt-in (default OFF). Backfill every
-- existing repo to OFF so none keeps the silent double-review when an external
-- reviewer is already running. Repos that want the audit re-enable it explicitly.
UPDATE `repos` SET `auto_pr_audit` = 0 WHERE `auto_pr_audit` = 1;
