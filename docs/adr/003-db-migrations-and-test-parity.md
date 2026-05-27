# ADR 003: Drizzle migrations applied uniformly in prod and tests

- **Status:** accepted
- **Date:** 2026-05-27

## Context

We need schema persistence (SQLite) and a way to spin up isolated databases in
unit tests without hitting the real `data/autoclaude.db` file or any external
service. The schema must stay in sync between test and production.

## Decision

`drizzle-kit generate` produces SQL migration artifacts under `drizzle/`. A single
`createDb(path)` factory opens a `better-sqlite3` connection and runs the
drizzle migrator against those artifacts. Tests call `createDb(":memory:")` for a
fresh, throwaway database; production uses `getDb()` which resolves the path from
`AUTOCLAUDE_DB` or `data/autoclaude.db`. WAL and `foreign_keys = ON` are enabled.

## Consequences

- Identical DDL runs in tests and production — no schema drift.
- Every service/query function takes an optional `db` parameter, so tests inject
  an in-memory DB; production falls back to the singleton.
- New schema changes require a `db:generate` step (committed migration files).
