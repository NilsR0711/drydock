# ADR 042: Scheduled in-process DB backup sweep

- **Status:** accepted
- **Date:** 2026-07-04

## Context

The SQLite database is the sole record of job history, cost accounting, prompts,
and repo config, and the project promises zero setup ("created and migrated
automatically on first start"). Backups, however, were entirely manual. [ADR
012](012-graceful-shutdown-and-backup.md) shipped `runBackup` (a WAL-safe
snapshot + retention prune) but deliberately left scheduling to the OS: "Backup
and retention is a pure, unit-tested function; scheduling is left to the OS."

Two things have changed since:

1. **The in-process sweep pattern.** [ADR 023](023-log-retention-and-pruning.md)
   added a daily in-process log-retention sweep (`startPruneSweep`) that runs at
   startup and every 24h under the single-instance lock. There is now an
   established, cheap cadence host for exactly this kind of housekeeping.
2. **Packaged/daemon installs.** `drydock start` and `drydock service install`
   users had no retention-managed backup path: the pruning `runBackup` lived only
   behind `pnpm backup` (which needs a repo checkout), while the packaged `drydock
   backup` intentionally never prunes. A cron'd `drydock backup` therefore grows
   `<data dir>/backups/` without bound, and an un-cron'd one means no backups at
   all — both silent until disk fills or the DB is lost. (A CLI comment even
   referred to "the server's scheduled backup job", which did not exist.)

## Decision

Add an opt-out daily in-process backup sweep alongside the log-retention sweep,
reusing `runBackup` from ADR 012. This **supersedes the scheduling decision of
ADR 012** ("scheduling is left to the OS") — the WAL-safe snapshot function and
its retention semantics are unchanged; only the "who schedules it" answer is.

### 1. Retention setting

A global `backupRetentionDays` setting (default **7**, matching the historical
`RETENTION_DAYS`) controls how long snapshots are kept. It lives in the existing
`settings` JSON blob and is surfaced on the Settings page — no migration needed,
mirroring ADR 023's `retentionDays`. **`0` disables the sweep entirely**: no
snapshots are written (the `0 = off` convention shared with the cost/turn
ceilings). A manual `drydock backup` still works when the sweep is off.

### 2. The sweep (`src/lib/backup/sweep.ts`)

`backupSweep()` reads the setting, writes a snapshot into `<data dir>/backups`
(derived from the resolved DB path), and prunes past the window via `runBackup`.
`startBackupSweep()` schedules it exactly like `startPruneSweep`: run once at
startup, then every 24h, timer `unref`'d, guarded by the single-instance lock and
skipped under Vitest, and — crucially — **failures are logged, never fatal**. To
avoid a footgun, `runBackup` treats a non-positive retention as "keep all" rather
than "prune everything", so a disabled/zero window can never delete every backup.

### 3. Monitoring surfaces

- `GET /api/health` gains `lastBackupAt` (ISO-8601 of the newest snapshot, or
  `null`), read from the filesystem so it reflects whatever process wrote it.
- `drydock doctor` gains a "last backup" probe: ok within the daily window, warn
  when stale or absent-with-a-DB, skip on a fresh install with no DB.

Monitoring can alert on a stale/absent `lastBackupAt` to catch a sweep that
stopped working — the failure mode ADR 012's manual approach left invisible.

## Consequences

- `drydock start` / `service install` users get hands-off backups with bounded
  retention out of the box; the "the server's scheduled backup job" comment is
  finally true.
- The sweep is opt-out (`backupRetentionDays = 0`) and runtime-reconfigurable
  without a restart, since it re-reads the setting each run.
- Trade-off: another daily in-process job and a small write amplification (one
  snapshot/day). Bounded by retention and skippable, so the cost stays flat.
- ADR 012's scheduling note is superseded; its backup function and semantics
  remain the foundation this builds on.
