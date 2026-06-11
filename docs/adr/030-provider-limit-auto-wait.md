# ADR 030: Provider usage-limit auto-wait (`waiting_limit` job state)

- **Status:** accepted
- **Date:** 2026-06-11

## Context

When the `claude` CLI exits because the Anthropic account's usage window is
exhausted (Pro/Max 5-hour or weekly limits, API 429/529), `run-job.ts` treated
it like any other agent failure: the job landed in `needs_human` with a generic
"exited non-zero" message. That is the wrong outcome for a transient provider
quota event — the session id and branch state are still valid, the operator is
paged for a condition that resolves itself, and on busy repos many jobs pile
into Needs human for one root cause. Drydock already has precedent for gated
waiting plus automatic resume (the daily cost-limit latch, ADR 008/024; the
GitHub rate-limit governor, ADR 018; queue backoff via `available_at`, ADR 022)
but nothing equivalent for provider account limits (issue #166).

A new job state is architecturally significant: ADR 005 defines the state
machine as an enforced allow-list, and every consumer (driver, queue, UI,
analytics, dedupe) keys off it.

## Decision

### 1. New job state `waiting_limit`

`working → waiting_limit` parks a job whose session failed on a **transient**
provider limit (`usage_limit`, `rate_limit`, `overloaded`). Exits:
`queued` (automatic resume), `needs_human`, `aborted`, `interrupted`
(operator). `waiting_limit` is non-terminal, counts as *open* for dedupe and as
*in-flight* for sequential repos (the work is mid-implementation), but **not**
toward `maxAttempts` failed-attempt budgets. Auth/billing failures keep routing
to `needs_human` — waiting cannot fix a revoked key or an empty balance.

### 2. Pattern-based classification at the provider boundary

The Claude CLI exposes no stable structured limit event across versions, so
`claudeProvider.classifyFailure` pattern-matches the session's stderr tail and
the stream's final `result` text into a normalized `ProviderLimitInfo`
(`kind`, optional `resetAt`/`retryAfterMs`, redacted snippet), covered by
table-driven fixture tests per known message shape. Only failed sessions are
classified; Drydock's own timeout/cost-cap aborts never are.

### 3. DB-persisted global latch with strike backoff

One latch per agent, stored under its own key in the settings KV table so it
survives restarts. The CLI-reported reset epoch (or retry-after hint) wins,
clamped to 60s–24h; otherwise a per-kind base cooldown doubles per consecutive
strike (capped), so recovery never spins against a dead quota. A successful
session clears the latch. While latched: the driver's `claimNext` excludes
`claude` jobs (other agents keep running), `spawnAgentSession` /
`resumeAgentSession` refuse to start Claude subprocesses at all (covers side
sessions and races), and the CI babysitter defers fix resumes within the CI
wait budget instead of burning retries.

### 4. Session-continuity resume

The park stores `jobs.limit_kind`; on requeue the marker survives. A parked job
with a recorded `session_id` resumes via the agent's resume mechanism
(`--resume`, ADR 014) on **its own model and turn budget** with a dedicated
`limit-resume` prompt template (the fresh worktree no longer has the
interrupted run's uncommitted edits), skipping the plan stage. Without a
session id it restarts fresh. No PR can be duplicated: the limit branch runs
strictly before PR creation, and CI-fix limits are waited out in place while
the worktree is alive.

### 5. Operator surface

`claude_limit` notification event fires edge-triggered on latch enter and
clear; the issue gets best-effort park/resume comments; the job detail page
shows the reason and next-attempt estimate. A global settings toggle
("Auto-wait on Claude usage limits", default on) restores the pre-#166
behavior when disabled.

## Consequences

- Operators stop being paged for self-resolving quota windows; parked jobs
  resume unattended, preserving session context where possible.
- A new non-terminal state means external consumers of job status (MCP,
  analytics) see an unfamiliar value; they treat unknown states generically.
- The classifier is heuristic by necessity; an unrecognized limit phrasing
  degrades to the old `needs_human` behavior (fail-safe), and new phrasings
  are added as fixtures.
- Codex gets the same treatment in a sibling issue; the latch, state and
  classifier hook are already agent-keyed.
