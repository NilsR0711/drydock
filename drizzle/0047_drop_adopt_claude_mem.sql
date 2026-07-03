-- Issue #375: claude-mem worktree adoption is now default behaviour, not a
-- per-repo opt-in. A settling job consolidates its per-worktree memory into the
-- parent project on every outcome, so the `adopt_claude_mem` toggle (added in
-- 0036) is obsolete and dropped.
ALTER TABLE `repos` DROP COLUMN `adopt_claude_mem`;
