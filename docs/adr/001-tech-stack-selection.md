# ADR 001: Tech Stack Selection

- **Status:** accepted
- **Date:** 2026-05-27

## Context

AutoClaude is a local single-user tool that autonomously processes GitHub issues
through Claude Code subprocesses. It needs server-side process management,
embedded persistence, live logs (realtime), and a UI. The spec (§2) mandates the
stack.

## Decision

We adopt the stack fixed in SPEC §2 without substitution: Node.js 22 + pnpm,
Next.js 15 (App Router, RSC + Server Actions), SQLite via `better-sqlite3` with
`drizzle-orm`/`drizzle-kit`, Tailwind v4, SSE for realtime, `node:child_process`
for subprocesses, the `gh` CLI for GitHub, Zod, Vitest, and Biome.

## Consequences

- Synchronous `better-sqlite3` fits the single-process model; no connection pools.
- Server Actions cover all mutations; Route Handlers are reserved for SSE.
- `instrumentation.ts` is the single place for the orchestrator singleton.
- Native builds (better-sqlite3) require `pnpm.onlyBuiltDependencies` approval.
