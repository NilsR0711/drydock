# ADR 039: Retire the custom OpenRouter backend in favour of opencode

- **Status:** accepted
- **Date:** 2026-06-20
- **Supersedes:** [ADR 032](032-openrouter-backend.md)

## Context

ADR 032 added `openrouter` as a bespoke **HTTP agent backend**: a streaming chat
client, a tool-loop session runner, a tool sandbox, a model-catalog sync into a
`openrouter_models` SQLite table, status-based limit classification, and a
dedicated settings block (~7 files under `src/lib/openrouter/` plus
`agents/openrouter*.ts`). It was the only `kind: "http"` provider; every execute
call site (`spawnAgentSession`, `resumeAgentSession`, `runOneShotAndRecordCost`)
carried a branch to dispatch to it.

ADR 038 then added **opencode** as a CLI agent. opencode routes through
[models.dev](https://models.dev) to 75+ providers **including OpenRouter** behind
one `provider/model` id (`openrouter/<model>`), reads `OPENROUTER_API_KEY` from
its environment (models.dev declares `env: ["OPENROUTER_API_KEY"]` for the
provider), and reports exact per-step USD cost in its JSONL stream. opencode
therefore replaces both OpenRouter's *model access* and its *cost reporting*
through the existing spawn/stream path — making the entire custom HTTP subsystem
redundant (issue #349 Step 2).

## Decision

**Remove the custom OpenRouter integration** and route OpenRouter through
opencode instead. Keep one thin bridge so existing users keep working with no
manual reconfiguration.

### 1. Delete the HTTP subsystem and the `kind` dimension

Removed `src/lib/openrouter/{client,session,tools,catalog,one-shot,actions}.ts`
and `agents/{openrouter,openrouter-limits}.ts`; dropped `openrouter` from
`AgentId`, the registry, and every enum. With the last `http` provider gone, the
`AgentProvider.kind` field and all `kind === "http"` dispatch branches are
deleted — **every agent is now a spawned CLI**, so the orchestrator has a single
execution path again.

### 2. Bridge the API key onto opencode (no user action)

The decision point (issue #349) was credentials: opencode manages provider auth
in its own `auth.json`, so a clean delete would force every OpenRouter user to
re-authenticate. Instead, Drydock keeps a single `openrouterApiKey` setting and
**injects it as `OPENROUTER_API_KEY` into the spawned opencode process**
(`agentSpawnEnv`, ADR 038 bridge). Migrated repos authenticate with zero user
action; `DRYDOCK_OPENROUTER_API_KEY` still overrides for headless deploys. An
empty key falls back to opencode's own configured auth.

### 3. Migrate existing data (migration 0046)

A repo/issue/job configured for the removed `openrouter` agent is converted to
`opencode`, with its bare OpenRouter model id prefixed `openrouter/` so opencode
addresses it via models.dev (`anthropic/claude-3.5-sonnet` →
`openrouter/anthropic/claude-3.5-sonnet`). The model is prefixed *before* the
agent flips so the guard matches; the migration is idempotent
(`NOT LIKE 'openrouter/%'`). Then `openrouter_models` is dropped. Repo model
validation now only enforces the `provider/model` shape for opencode (opencode
validates against models.dev itself); the historical `openrouter_models` migration
(0028) stays for DBs that ran it.

### 4. Cost safety preserved; OpenRouter-specific policies dropped

Per-job cost-cap enforcement already works generically for CLI agents: the cost
guard prices from the parser's streamed `costUsd` (ADR 038), so opencode ships
without a cost-safety regression — daily budgets and the costs page are unchanged.

Two OpenRouter-only options are **dropped** (issue #349 open question 2; the
issue sanctioned dropping them):

- **free-models-only policy** — required the synced catalog to enforce. Users
  pick a free model explicitly (`openrouter/…:free`); cost caps still bound spend.
- **provider-limit auto-wait for OpenRouter** — opencode has no `classifyFailure`,
  so an OpenRouter 429 surfaced through opencode escalates generically to
  `needs_human` rather than auto-waiting. claude/codex limit auto-wait is
  unchanged. The provider-limit records are keyed by a `LimitAgentId` subset
  (claude/codex) rather than carrying a dead opencode/openrouter entry.

## Consequences

- One execution model (spawned CLIs); a large bespoke HTTP subsystem and its
  catalog table/sync are gone, simplifying the agent surface.
- OpenRouter (and local/other providers) are reached through one
  externally-maintained agent; new models appear without a Drydock release.
- Existing OpenRouter users keep working: repos auto-migrate and the stored key
  is bridged onto opencode. No `defaultAgent`/PR-audit changes — those stay on
  the static-catalog CLI agents (claude/codex).
- Trade-offs accepted: no free-models-only enforcement and no OpenRouter limit
  auto-wait. Adding opencode usage-limit detection is possible future work.
- A repo whose key lives only in opencode's own auth needs no Drydock key at all
  (empty `openrouterApiKey`).
