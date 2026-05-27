# ADR 008: Cost tracking source of truth

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Each job's USD cost must be recorded. Claude's `stream-json` `result` event often
carries `total_cost_usd`, but it may be absent (older CLI, interrupted run). We
need a deterministic fallback.

## Decision

Prefer the authoritative `total_cost_usd` from the final `result` event. If it is
missing or zero, estimate from accumulated input/output tokens × the per-model
rate table in `pricing.ts` (Sonnet 4.5 $3/$15, Haiku 4.5 $1/$5 per MTok, dated
2026-05). The `StreamJsonParser` accumulates tokens/cost as it parses; the session
writer persists the final numbers to the `jobs` row. Crash recovery (ADR 006) is
also referenced here as state §8.

## Consequences

- Costs are recorded even without a `total_cost_usd` field.
- Pricing updates are a one-line table edit.
- Token estimates can diverge slightly from billed cost when caching is involved;
  acceptable for a local dashboard.
