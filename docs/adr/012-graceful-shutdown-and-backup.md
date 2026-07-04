# ADR 012: Graceful shutdown, abort registry & DB backup

- **Status:** accepted — scheduling **superseded by [ADR 042](042-scheduled-in-process-backup-sweep.md)**
- **Date:** 2026-05-27

## Context

A long-running orchestrator owns child processes and in-flight job state. On
process exit (SIGINT/SIGTERM) we must not leave jobs stuck `working` nor orphan
subprocesses. We also need cheap, local point-in-time DB backups with retention.

## Decision

`startOrchestrator` installs `process.once` SIGINT/SIGTERM handlers that call
`gracefulShutdown`: it flips every `working`/`ci_running`/`retrying` job to
`interrupted` in one statement and invokes each registered abort callback.
`spawnClaudeSession` registers its `handle.abort` (SIGTERM → SIGKILL after 5s) in
an in-memory registry keyed by job id and clears it on exit. Backups
(`runBackup`) copy the SQLite file to a timestamped name and unlink backups older
than 7 days; exposed as `pnpm backup` for a daily cron/launchd job.

## Consequences

- Clean restarts: interrupted jobs are visible and restartable (with recovery).
- No orphaned `claude` processes on shutdown.
- Backup/retention is a pure, unit-tested function; scheduling is left to the OS.
  (Superseded: [ADR 042](042-scheduled-in-process-backup-sweep.md) now schedules
  this same `runBackup` as an opt-out daily in-process sweep. The function and its
  WAL-safe/retention semantics are unchanged; only "who schedules it" is.)
