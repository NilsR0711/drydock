# ADR 006: Orchestrator as an instrumentation-hosted singleton

- **Status:** accepted
- **Date:** 2026-05-27

## Context

The orchestrator owns long-lived state (running jobs, timers, watchers). Next.js
can evaluate modules in multiple contexts; we need exactly one orchestrator per
server process, started deterministically.

## Decision

`instrumentation.ts` is compiled for both the node and edge runtimes, so it must
not import node-only modules (better-sqlite3/node:fs) — webpack compiles the
graph for edge even behind a runtime guard. We therefore bootstrap the
orchestrator lazily on the first `getDb()` call (node server runtime only):
`startOrchestrator()` is guarded by a module-level `started` flag and runs crash
recovery + installs signal handlers. `better-sqlite3` and `chokidar` are declared in
`serverExternalPackages` so they are not bundled. The driver polling loop is
wired in once real Claude sessions exist (Phase 4) to avoid an idle spin.

## Consequences

- Single, predictable init point; no double-start.
- Background work lives outside the request lifecycle.
- Server Actions/RSC reach orchestrator state via the shared DB singleton.
