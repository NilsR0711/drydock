# ADR 009: CI babysitter & retry strategy

- **Status:** accepted
- **Date:** 2026-05-27

## Context

After a PR is opened we must watch CI, auto-merge on green, and recover from red
without human input where possible — bounded so a job can't loop forever.

## Decision

`ciBabysitter` polls `gh pr checks` every 30s. `classifyChecks` reduces the set to
pending/passed/failed (any failing state → failed; any pending → pending; else
passed). On passed → `gh pr merge --squash --auto` then transition `merged`. On
failed → transition `ci_failed`; if `ci_retry_count < 3`, fetch the failed log
(`gh run view --log-failed`, tail 8000 chars), resume the session with Haiku
(`--resume <id> --max-turns 15 --model claude-haiku-4-5`), increment the counter,
and go back to `ci_running`. After 3 failures → comment on the issue, file a
follow-up issue, and transition `needs_human`. All collaborators (`gh`, resume,
sleep) are injected for deterministic tests.

## Consequences

- Auto-merge and self-healing CI without human intervention in the common case.
- Hard retry cap of 3 prevents infinite loops; cheap Haiku model for retries.
- Follow-up issues create a paper trail for abandoned jobs.
