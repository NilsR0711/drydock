# ADR 032: OpenRouter as an HTTP agent backend with an auto-syncing model catalog

- **Status:** accepted
- **Date:** 2026-06-11

## Context

Drydock's model surface is static and CLI-centric: `MODELS[]` is hardcoded,
`AgentId` covers the `claude` and `codex` CLIs (ADR 014), and pricing tables
are maintained by hand. OpenRouter hosts a continuously changing catalog of
models — including free-tier ones — behind one OpenAI-compatible HTTP API and
publishes the catalog (ids, pricing, capabilities, sunsets) on a public Models
endpoint. Operators want to run cheap/free models for low-risk stages (triage,
decomposition, verification, PR audits) and optionally for implementation
jobs, without a Drydock release every time OpenRouter adds or retires a model
(issue #169). This cuts across the agent provider abstraction (ADR 014), cost
accounting (ADR 008), provider-limit handling (ADR 030), settings/secrets
(ADR 023), and the schema/migration conventions (ADR 003) — hence this ADR.

## Decision

Add **`openrouter` as a third `AgentId`** — an **HTTP-backed provider** next
to the CLI agents — plus a **local mirror of the OpenRouter model catalog**
that refreshes automatically. Off by default; enabling is a settings switch
plus an API key.

### 1. Provider with an execution-kind dimension

`AgentProvider` gains `kind: "cli" | "http"` (omitted = `cli`). The
openrouter provider has no CLI surface: `buildStartArgs`/`buildOneShotArgs`/
`createParser` fail fast, `buildResumeArgs`/`buildStreamOneShotArgs` return
the interface's documented "unsupported" value. Call sites that execute —
`spawnAgentSession`, `resumeAgentSession`, `runOneShotAndRecordCost` —
dispatch on `kind` to HTTP implementations in `src/lib/openrouter/` that
mirror the existing result contracts (`AgentSessionResult`, `OneShotResult`),
so the orchestrator, babysitter, and cost plumbing stay provider-agnostic.

Alternative considered: pointing the Codex CLI at OpenRouter's base URL.
Rejected — it ties capability to one CLI's provider support, hides errors
behind CLI heuristics, and cannot expose OpenRouter's usage accounting.

### 2. Catalog mirrored into SQLite

`openrouter_models` (migration 0028) mirrors `GET /api/v1/models`: per-token
USD pricing, `supported_parameters`, `context_length`, `expiration_date`,
derived `is_free` (zero pricing or `:free` id) and `supports_tools`. Sync
upserts, **soft-deletes** vanished models (`removed_at`, preserving labels on
historical jobs), and revives returning ones. Sync metadata (last success,
last error, failure streak) lives in the settings KV table — like the
provider-limit latch (ADR 030) — and drives exponential retry backoff plus a
stale-catalog warning in the UI. On fetch/HTTP failure the last-good snapshot
keeps serving pickers and validation (offline-safe). The driver tick kicks
off a sync when due, **fire-and-forget** with an in-flight guard, so a slow
Models API can never block job claims.

### 3. Tool-loop implementation sessions, capability-gated

Implementation jobs run a bounded tool loop over streaming chat completions:
`read_file`, `write_file`, `list_dir`, `run_command`, all rooted in the job's
worktree with a path guard, output caps, and per-command timeouts. Jobs are
**gated to catalog models with `tools` support**; one-shots (decompose,
verify, plan, PR audit) accept any available catalog model. The loop honors
the existing orchestrator guarantees: wall-clock timeout, per-job cost cap,
abort registration, pre-spawn limit-latch refusal, and the same job usage
persistence as CLI sessions. OpenRouter has no session resume, so CI fixes
and limit resumes run a **fresh context** with the fix/continuation prompt
(`supportsResume: false`), accumulating cost additively.

The trust model matches the CLI agents: Claude/Codex already run with full
shell access in the same worktree, so `run_command` grants nothing new — but
enabling OpenRouter sends repository code to a third-party inference
provider, which the settings UI states explicitly next to the switch.

### 4. Cost: stream usage accounting first, catalog estimate second

Requests set `usage: {include: true}`; OpenRouter reports exact USD cost in
the final stream chunk, which is authoritative. When a stream dies before
reporting, the session/one-shot runner estimates from the catalog's per-token
rates. `provider.estimateCost` returns 0 by design — a static table would
drift from the live catalog. Spend lands in `jobs.costUsd`/`one_shot_costs`,
so daily budgets, per-repo limits, and the costs page include OpenRouter
without changes (ADR 008).

### 5. Limits, validation, selection

HTTP failures classify status-first into the ADR 030 latch: 429 →
`rate_limit` (or `usage_limit` on free/daily-quota wording), 401/403 →
`auth`, 402 → `billing`, 408/5xx → `overloaded`, with `Retry-After` honored
and an `openrouterLimitAutoWait` toggle plus its own notification event.
Repo `agent`/`defaultModel` pairs validate against the **synced catalog**
(exists, not removed/expired, free-models-only policy) instead of the static
`MODELS[]`; expired/removed models disappear from pickers and fail with an
actionable "refresh the catalog" error if still referenced. The global
`defaultAgent` stays a CLI agent: OpenRouter is selected per repo or job,
with `openrouterDefaultModel` as the configured fallback. The API key is
stored in settings (redacted by the existing `sk-` pattern, ADR 023) and can
be overridden by `DRYDOCK_OPENROUTER_API_KEY` for headless deployments.

## Consequences

- New OpenRouter models appear in pickers within the refresh interval — no
  release needed; deprecations hide automatically at their sunset date.
- A third agent dimension exists everywhere `AgentId` flows; CLI-only
  surfaces (PR-audit agent override, global `defaultAgent`) deliberately
  exclude it for now and can adopt it later.
- Free-tier models make zero-cost triage/verify/audit runs possible, with a
  `openrouterFreeModelsOnly` policy to enforce it.
- Off by default: with the switch off, behavior is byte-for-byte the
  pre-#169 CLI behavior.
- Chat-only models cannot run implementation jobs by construction; the gate
  produces an explicit, actionable error instead of a broken session.
