# ADR 018: Priority-aware GitHub API rate-limit budgeting

- **Status:** accepted
- **Date:** 2026-05-28

## Context

Every GitHub call goes through `src/lib/github/gh.ts` (a wrapper around the `gh`
CLI). There was no central rate-limit accounting or request prioritization. For
larger public repos and multi-repo watching, the background poll loop
(`driveTick`) can eat the API budget that interactive UI actions and active jobs
need — and a single burst can drain the budget to zero, leaving the whole tool
stalled until the window resets.

## Decision

Add a process-wide, priority-aware **rate-limit governor** that meters every
`gh` request so background work yields to interactive work and nothing can zero
out the budget.

### 1. Per-resource budget state (`rate-limit.ts`)

`RateLimitGovernor` tracks `remaining` / `limit` / `reset` per resource
(`core`, `graphql`, `search`), derived from response headers
(`x-ratelimit-*`). State is seeded each sweep from GitHub's free `/rate_limit`
endpoint (`GhClient.refreshRateLimit`, which does not count against any budget)
and refined from the headers of real list responses.

### 2. Request priority (`priority.ts`)

An `AsyncLocalStorage` scope tags requests `high` or `low`. The default outside
any scope is `high`, so interactive routes and active jobs opt in to nothing;
only the background sweep wraps itself in `withPriority("low", …)`.

Gating in `decide(resource, priority)`:

- **Reserve fraction (0.3):** below 30 % remaining, `low` requests are gated so
  the rest is reserved for interactive routes and active jobs. `high` flows.
- **Hard floor (0.05):** below 5 %, *every* request is gated regardless of
  priority — even high-priority automation cannot drain the budget to zero.
- A reset that has already elapsed is treated as stale (budget refilled), so the
  governor never deadlocks waiting on out-of-date state.

A gated request throws `RateLimitError` before any `gh` process is spawned. In
the sweep this is back-pressure, not an error: the repo is skipped quietly and
retried next tick.

### 3. 429 handling

On an actual 429 (or a primary-limit 403 with `remaining: 0`), the resource is
backed off until `x-ratelimit-reset` (fallback ~60 s). A rate limit reported by
`gh` on stderr falls back to the ~60 s window. All requests are gated for the
duration.

### 4. Cheap polling via conditional requests

`listIssues` / `listAllIssues` fetch through `gh api repos/{owner}/{repo}/issues
--include` with an `If-None-Match` header carrying the last ETag. An unchanged
list returns **304 Not Modified** and is served from a per-repo ETag cache,
spending no budget — enabling more repos per sweep. Pull requests the REST
issues endpoint includes are filtered out so the result matches the previous
`gh issue list` shape.

### Unchanged invariants

- Interactive behaviour is unchanged: with an empty governor and the default
  `high` priority, no request is ever gated.
- The governor is GitHub-specific. `ForgeClient.refreshRateLimit` is optional;
  the GitLab forge omits it.

## Consequences

- The conditional list path fetches up to 100 open issues per repo (one page,
  ETag-friendly), down from the previous 200-issue `gh issue list` cap. This is
  ample for one-at-a-time issue processing; revisit with per-page ETags if a
  watched repo ever carries more than 100 actionable open issues.
- A single shared governor assumes one `gh` token per machine (the norm). Repos
  authenticating as different users would share one budget view.
