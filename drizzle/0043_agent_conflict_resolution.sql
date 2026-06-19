-- issue #327: opt-in agent-assisted resolution of genuine merge conflicts in
-- the branch janitor. Independent of (and riskier than) the plain-rebase
-- auto_resolve_merge_conflicts, so it defaults OFF; a repo opts in explicitly.
ALTER TABLE `repos` ADD COLUMN `resolve_conflicts_with_agent` integer NOT NULL DEFAULT 0;
