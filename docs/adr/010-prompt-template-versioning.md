# ADR 010: Prompt template versioning & variable substitution

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Prompts evolve; we want history and the ability to see which version a job used,
capped so the table doesn't grow unbounded. Prompts also contain variables
($ISSUE_NUM, $BRANCH, $REPO_NAME) that must render with real or sample data — and
the renderer must be usable inside a client component (Monaco preview) without
dragging in the DB layer.

## Decision

Each save appends a new `prompt_templates` row with an incremented `version`
(scoped to repo + name); versions beyond the newest 20 are pruned. The active
template is the highest version. Pure substitution lives in `prompts/render.ts`
(no DB imports) so client components import it directly; `templates.ts` re-exports
it for server code. Longest-token-first replacement avoids partial overlaps;
unknown/missing tokens are left intact.

## Consequences

- Full, bounded version history; active = latest.
- Client/server import boundary respected (no better-sqlite3 in the browser bundle).
- A future job reads the active template at spawn time, picking up edits.
