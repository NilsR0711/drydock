-- Retire the custom OpenRouter HTTP backend in favour of opencode (#349 Step 2,
-- ADR 039). opencode reaches OpenRouter natively via `openrouter/<model>` ids,
-- so migrate every record configured for the removed `openrouter` agent to
-- `opencode`, prefixing its bare OpenRouter model id with `openrouter/`. Prefix
-- the model BEFORE flipping the agent so the WHERE clause still matches. Then
-- drop the now-unused mirrored model catalog.

UPDATE repos SET default_model = 'openrouter/' || default_model
  WHERE agent = 'openrouter' AND default_model NOT LIKE 'openrouter/%';
--> statement-breakpoint
-- Prefix per-issue model overrides BEFORE flipping repos, so the repo-agent check
-- still resolves. Covers both an explicit `agent_override='openrouter'` and an
-- inherited one (no agent_override → the issue runs under its repo's agent).
UPDATE issues SET model_override = 'openrouter/' || model_override
  WHERE model_override IS NOT NULL
    AND model_override NOT LIKE 'openrouter/%'
    AND (
      agent_override = 'openrouter'
      OR (agent_override IS NULL AND repo_id IN (SELECT id FROM repos WHERE agent = 'openrouter'))
    );
--> statement-breakpoint
UPDATE issues SET agent_override = 'opencode' WHERE agent_override = 'openrouter';
--> statement-breakpoint
UPDATE repos SET agent = 'opencode' WHERE agent = 'openrouter';
--> statement-breakpoint
UPDATE jobs SET model = 'openrouter/' || model
  WHERE agent = 'openrouter' AND model IS NOT NULL AND model NOT LIKE 'openrouter/%';
--> statement-breakpoint
UPDATE jobs SET agent = 'opencode' WHERE agent = 'openrouter';
--> statement-breakpoint
DROP INDEX IF EXISTS openrouter_models_free_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS openrouter_models_removed_idx;
--> statement-breakpoint
DROP TABLE IF EXISTS openrouter_models;
