# ADR 023: Log retention, SQLite pruning & secret redaction

- **Status:** accepted
- **Date:** 2026-05-28

## Context

Long-running autonomous operation accumulates data without bound. Every agent
session streams stdout/stderr into the `job_events` table via the log broker, and
that table is append-only — a busy multi-repo install grows it indefinitely,
bloating the SQLite file and slowing queries. Two further risks compound this:

- **Secrets in logs.** Agent output, `gh` invocations, and API error bodies can
  echo GitHub/GitLab access tokens or `Bearer` headers. Persisting those to
  `job_events` (and streaming them to the UI) leaks credentials into the database
  and onto any connected client.
- **Cost history.** The cost dashboard sums `costUsd`/token columns on the `jobs`
  rows. Any pruning must not delete the data that reporting depends on.

There was no retention configuration, no pruning routine, and no redaction.

## Decision

Add configurable retention with an automatic + manual prune path, and redact
secrets at the single point where log events are persisted.

### 1. Retention setting

A global `retentionDays` setting (default **30**, positive integer) controls how
long a finished job's verbose events are kept. It lives in the existing `settings`
JSON blob and is surfaced on the Settings page — no migration needed.

### 2. Pruning (`src/lib/db/prune.ts`)

`pruneOldData(db, { days?, vacuum?, now? })` deletes `job_events` belonging to jobs
whose `finishedAt` is older than the cutoff (`now − days`). It deliberately keeps
the **job summary rows** (status, cost, tokens) so cost history survives, and never
touches events of unfinished jobs regardless of event age. After deleting it runs
SQLite `VACUUM` (outside any transaction) to return freed pages to the OS, unless
disabled.

Tying retention to `finishedAt` — rather than raw event timestamps — gives clean
semantics ("finished work older than N days loses its verbose log") and protects a
long-running job's in-progress logs.

### 3. Two prune paths

- **Scheduled:** a daily in-process sweep starts with the driver loop (startup +
  every 24h, `unref`'d). It is skipped under Vitest and guarded by the
  single-instance lock, like the rest of the orchestrator wiring. Failures are
  logged, never fatal.
- **Manual:** `pnpm db:prune [--days <n>] [--no-vacuum]` runs the same function
  against the configured database for cron/launchd or ad-hoc use. (Named under the
  `db:` namespace to avoid colliding with pnpm's built-in `prune` command.)

### 4. Secret redaction (`src/lib/log/redact.ts`)

`redactSecrets(text)` masks GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and
fine-grained `github_pat_`), GitLab `glpat-` tokens, and `Bearer` authorization
values with `[REDACTED]`. It is applied in `LogBroker.publish` to the serialized
payload before it is both persisted and streamed, so a single chokepoint covers
every event source.

## Consequences

- The SQLite file no longer grows without bound; verbose logs self-expire while
  cost reporting stays intact.
- Operators get both hands-off retention and an on-demand `db:prune` knob.
- Tokens accidentally emitted by agents never reach the database or the browser.
- Trade-off: pruned events are gone — a job's detailed log is unavailable past the
  retention window, by design. Backups (ADR 012) remain the recovery path for the
  retention period.
