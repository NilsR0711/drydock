# Drydock

A local, single-user web app (http://localhost:3737) that autonomously processes
GitHub issues through Claude Code subprocesses — with CI babysitting, auto-merge,
ADR review, live logs, and cost tracking.

> Local tool, no auth, no cloud, no multi-user. Binds `127.0.0.1` only.

## Stack

Next.js 15 (App Router, RSC + Server Actions) · SQLite (`better-sqlite3`) +
Drizzle · Tailwind v4 · SSE for live logs · `node:child_process` for the
`claude` and `gh` CLIs · Zod · Vitest · Biome.

## Quickstart

```bash
pnpm install        # install deps (builds better-sqlite3)
pnpm db:generate    # (only after schema changes) regenerate migrations
pnpm test           # run the unit suite
pnpm build          # production build
pnpm dev            # dev server on http://127.0.0.1:3737
```

The database lives at `data/drydock.db` (gitignored) and migrates itself on
first connection. Override the path with `DRYDOCK_DB`.

### Requirements

- Node.js 22 + pnpm
- `claude` and `gh` CLIs on `PATH` (configurable under **Settings**), authenticated
  for the repos you manage.

## How it works

`instrumentation.ts` starts a single orchestrator per server process. On boot it
runs crash recovery (in-flight jobs → `interrupted`) and installs graceful-shutdown
handlers (SIGINT/SIGTERM → mark interrupted, SIGTERM subprocesses, SIGKILL after 5s).

Each job moves through an explicit state machine:

```
queued → working → ci_running → ci_failed → retrying → merged | needs_human | aborted
```

- **Sessions:** `claude -p … --output-format stream-json --verbose` is spawned;
  its NDJSON stdout is parsed incrementally, persisted to `job_events`, and pushed
  to the browser over SSE. Cost comes from the result event's `total_cost_usd`, or
  is estimated from tokens × the rate table in `src/lib/orchestrator/pricing.ts`.
- **CI babysitter:** polls `gh pr checks`; merges on green; on red, resumes the
  session with Haiku (up to 3 retries), then files a follow-up issue and hands off.
- **ADRs:** a chokidar watcher registers new `docs/adr/*.md` files for review.

## Screens

Dashboard (`/`), repo detail (`/repos/[id]`), job detail with live log
(`/jobs/[id]`), prompt editor (`/prompts`), ADR review (`/adrs`), cost dashboard
(`/costs`), settings (`/settings`).

## Operations

- **Backups:** `pnpm backup` copies the DB into `data/backups/` and prunes
  anything older than 7 days. Schedule it daily (cron/launchd).
- **Pause / cost limit:** global pause and a daily-cost limit gate the driver loop
  (**Settings**).

## Development

- Strict TDD; tests under `tests/` never touch the network — the `claude`/`gh`
  CLIs are injected as fakes (see ADR 004).
- Conventional Commits. Architecture decisions live in `docs/adr/` (index:
  `docs/DECISIONS.md`); phase progress in `docs/PROGRESS.md`.

```bash
pnpm exec biome check .   # lint + format check
```
