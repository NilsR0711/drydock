# ADR 022: Lease-based persistent job queue with crash recovery

- **Status:** accepted
- **Date:** 2026-05-28

## Context

The driver loop claimed jobs by transitioning them `queued → working` and tracked
the active set in an in-memory `Set<number>`. Crash recovery on boot marked every
in-flight job `interrupted` for an operator to restart. That is fragile for
autonomous, multi-repo operation:

- A process crash loses the in-memory active set; jobs left `working` need manual
  intervention rather than resuming.
- Nothing ties a running job to the worker executing it, so there is no basis for
  detecting an abandoned job or rejecting a finalize from a worker that has lost
  ownership.
- Issue sync relied solely on an application-level `hasOpenJob` check to avoid
  enqueuing the same issue twice — a race could still create duplicates.

## Decision

Harden job execution into an explicit **lease-based queue** persisted in SQLite,
reusing the existing `jobs` table and state machine rather than introducing a
separate queue store.

### 1. Lease columns on `jobs`

A migration adds `attempts`, `lease_token`, `lease_expires_at`, `worker_id`,
`available_at` and `dedupe_key`, plus a lease-expiry index and a **partial unique
index** on `dedupe_key` scoped to live (non-terminal) jobs. The partial scope lets
a key be reused once its prior job reaches `merged`/`aborted`.

### 2. Claim / heartbeat / finalize (`src/lib/orchestrator/queue.ts`)

- `claimNext({ repoIds?, leaseMs, worker })` atomically claims the globally
  highest-priority eligible job (status `queued`, `available_at` due, within the
  optional repo allow-list), stamping a fresh lease token, worker id and expiry,
  incrementing `attempts`, and transitioning it to `working`. better-sqlite3
  transactions are synchronous and serialized on the single process connection, so
  the select-then-update is an atomic claim.
- `heartbeat(jobId, token, { leaseMs })` extends the lease, and `releaseLease(jobId,
  token)` clears it. Both require the matching token (optimistic lock): a worker
  that lost its lease cannot extend or finalize the job.

The driver claims via `claimNext`, runs a heartbeat interval (10s against a 30s
lease) for the duration of `runJob`, and releases the lease in the `finally` so a
settled job is never mistaken for orphaned.

### 3. Crash recovery

`recoverOnStartup` requeues jobs left `working` by a crashed worker back to
`queued` with an attempt-scaled backoff via `available_at` (their lease holder is
gone, so the lease is treated as expired). CI-babysitting states
(`ci_running`/`ci_failed`/`retrying`) still park as `interrupted`: they carry live
PR/CI state that must not silently restart. Recovery and the driver loop run in the
real server only (skipped under Vitest) so lazy `getDb()` bootstraps never mutate
per-test databases.

### 4. Backoff + dedupe

`backoffSeconds` is exponential (5s base, doubling, capped at 300s) and scales by
`attempts`. `enqueueJob` derives a dedupe key (`${repoId}:${issueNumber}` by
default), skips when a live job already holds it, and treats a lost race
(constraint violation from the partial unique index) as a no-op. The driver's
issue-sync stage enqueues through it.

### 5. Single-instance lock

The existing PID lockfile (`acquireInstanceLock`, `instance.lock` under the
worktree home) already provides the single-instance guard with a liveness check:
a lock held by a live PID refuses the second instance, while a stale (dead-PID) or
corrupt lock is taken over atomically via `O_EXCL`. `startOrchestrator` gates the
driver loop on it, so a second Drydock instance will not race the same queue.

## Consequences

- A killed process's in-flight work resumes automatically on restart instead of
  stranding in `working`; repeated crashes back off rather than hot-looping.
- Lease tokens give optimistic locking: heartbeats and finalizes from a stale
  owner are rejected, the foundation for safe concurrency.
- Duplicate enqueues are prevented at the database, not just in application logic.
- **Deviation from the issue sketch:** the listed `claimNext({ kinds })` filter is
  omitted — there is a single job kind today, so a `kinds` parameter would be dead.
  The repo allow-list (`repoIds`) is the real selection filter the scheduler needs.
  Retry/defer is realized through requeue + `available_at` backoff rather than a
  separate finalize verb, and per-issue retry caps remain governed by the existing
  `maxAttempts` sweep.
