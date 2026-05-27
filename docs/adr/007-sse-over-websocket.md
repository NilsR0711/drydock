# ADR 007: SSE (not WebSocket) for live logs + stream parsing strategy

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Live logs are strictly server → client (job events). We also must parse Claude's
`--output-format stream-json` (NDJSON) where stdout arrives in arbitrary chunks
that may split a JSON line.

## Decision

Use Server-Sent Events: one-directional, native `EventSource`, auto-reconnect,
plain HTTP — no extra protocol/library. A single Route Handler streams events;
on connect it replays the last 200 persisted `job_events`, then subscribes to the
in-process `LogBroker`. Parsing uses a stateful `StreamJsonParser` that buffers a
partial line until a newline, validates each line with Zod, and accumulates
session id / tokens / cost. The buffered `flush()` handles a trailing line at exit.

## Consequences

- No WebSocket server or client lib; fits Next.js Route Handlers cleanly.
- Replay-then-live gives reconnect resilience without gaps.
- Chunk-boundary handling is unit-tested (split-line fixture).
