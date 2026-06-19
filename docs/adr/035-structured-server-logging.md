# ADR 035: Structured server-log sink with a global Logs page

- **Status:** accepted
- **Date:** 2026-06-19

## Context

Drydock streamed only **per-job** logs (the SSE broker persists `job_events` and
fans them out to the job-detail viewer, ADR 007). Server-level diagnostics — the
driver loop, forge sync, orchestrator lifecycle, credential watchdog — only ever
reached `console` via `logError`, so once a process scrolled them off there was
no global, searchable view of what the server itself had been doing (issue #294).

Forces:

- Diagnostics happen during bootstrap, before the DB/settings are available, so
  the sink cannot depend on the database for its own configuration.
- Secrets routinely appear in error output (gh/git stderr, env dumps); they must
  never land on disk or on a connected client (issues #24, #110).
- Next.js compiles Server Actions, Route Handlers, and instrumentation into
  separate bundle layers, so a record emitted in one layer must still reach an
  SSE subscriber in another (issue #232).
- The viewer needs the same filter semantics on the initial snapshot and on the
  live tail, or a record would render differently depending on how it arrived.

## Decision

Add a process-wide structured logger (`src/lib/log/server-log.ts`) that records
each event three ways: a redacted **NDJSON line appended to a size-rotating log
file**, an echo to the **process console** (so the daemon's captured stdio still
shows it), and an in-process **fan-out to live subscribers** (the Logs page SSE
tail). Records carry a monotonic `seq` (continued from the file on restart) used
as the SSE resume cursor, mirroring the per-job broker.

- **Redaction** reuses `redactSecrets` over the serialized record, so a secret in
  any field — not just the message — is scrubbed before write/emit.
- **Rotation/retention** keeps `<file>` plus `DRYDOCK_LOG_MAX_FILES` rotated
  copies, each bounded by `DRYDOCK_LOG_MAX_BYTES`; the oldest is dropped.
- **Configuration** is layered: env (`DRYDOCK_LOG_LEVEL`, `DRYDOCK_LOG_FILE`,
  size/count) seeds the sink at bootstrap; the `logLevel` **setting** then takes
  over at runtime (pushed down on save and on orchestrator start). The file path
  is env-only — it is fixed for a run. A transient/in-memory DB disables the file
  sink so tests never write stray logs.
- **Pure shapes** (`types.ts`: levels, `LogRecord`, `matchesLogFilter`) and the
  viewer merge helper (`view.ts`) carry no `node:*` imports, so the `"use client"`
  Logs viewer imports them without pulling the file system into the browser
  bundle. The singleton lives on `globalThis` for cross-layer sharing.
- The existing `logError` (and new `logInfo`/`logWarn`/`logDebug`) route through
  this sink, so every diagnostic flows into the global view.

A global **Logs page** (`/logs` + `GET /api/sse/logs`) renders an initial
server-side window, then live-tails over SSE with a level filter and text search
applied identically on replay and live fan-out.

## Consequences

- **Positive:** one searchable, level-filterable, live-tailing view of all
  server activity; durable, tail-able, rotation-bounded log files; secrets are
  redacted at the single sink boundary; runtime-adjustable verbosity with a safe
  pre-DB bootstrap default; the client bundle stays free of `node:fs`.
- **Negative:** a new subsystem to maintain; reading the file on each snapshot is
  bounded by rotation (acceptable at the default 5 MB cap, not a full-text index);
  file logging is the dashboard server's only — the separate MCP process logs to
  its inherited stdio rather than the shared file to avoid cross-process rotation
  races.
