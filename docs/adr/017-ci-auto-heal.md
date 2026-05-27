# ADR 017: Opt-in CI auto-healing (classify → fix → verify, with hard budgets)

- **Status:** accepted
- **Date:** 2026-05-27

## Context

When a Drydock PR's CI fails, the existing `ci-babysitter` resumes the agent
with the failed log up to a flat retry count (ADR 009). That is blunt: it
retries everything the same way — including failures no code change can fix
(missing secrets, cancelled runs, external 5xx, AI-review gates) and flaky
timeouts — and it has no notion of whether an attempt actually improved
anything. On a public repo this risks looping and burning the cost cap.

## Decision

Add an **opt-in**, per-repo CI auto-heal pipeline (`autoHealCi`, default off)
that turns the failure path into a structured *classify → fix → verify* loop
with hard budgets. It never auto-merges; a human still reviews every PR.

### 1. Deterministic failure classification

`ci-failure-classifier.ts` maps a failing check (name + state + failed log) into
four buckets via keyword/regex rules — no LLM call, so it is free and testable:

- `healable_in_branch` — typecheck / lint / unit tests / build / generated
  artifacts. Eligible for a code fix.
- `blocked_external` — cancelled runs, missing secrets, external 5xx / rate
  limits, AI-review style gates. **Never code-healed** — handed to a human.
- `flaky_or_ambiguous` — timeouts / intermittent failures. Eligible for a plain
  re-run, not a code edit.
- `unknown` — nothing matched → escalate.

Each failure gets a `provider:category:checkName` **fingerprint** for dedupe and
per-failure budgeting. Precedence is blocked → flaky → healable → unknown, so we
never spend a code-fix attempt on something external.

### 2. SHA-bound healing sessions

A heal session (`healing_sessions`) is bound to a PR + head SHA and walks a small
state machine: `triaging → awaiting_slot → repairing → awaiting_ci → verifying →
healed`, with `cooldown` (retry on the same head), and the terminals `blocked`,
`escalated`, and `superseded`. When the PR head moves, in-flight sessions on the
old SHA are **superseded** and a fresh one opens for the new SHA.

### 3. Hard budgets

Bounded so it can never loop forever or drain the cost cap:

- `maxHealAttemptsPerSession` (default 3) and `maxHealAttemptsPerFingerprint`
  (default 2).
- A `cooldown` between attempts (default 15 min).
- `maxConcurrentHealingRuns` (default 1) across all repos.
- One failing check type per attempt; evidence fed to the agent is capped.

### 4. Verification (no empty heals)

After an attempt, the next CI verdict is verified: an attempt that pushed **no
new commit** (head SHA unchanged) is *rejected*, and one that did **not reduce**
the failing-check count is rejected for lack of measurable improvement. Rejected
attempts are not counted as success — they escalate to a human with a follow-up
issue. All-green is `healed`; fewer-but-nonzero is `progressed` and the loop
continues on the new head.

### Unchanged invariants

- Off by default and independent of auto-triage / auto-processing (ADR 016).
- The non-heal babysitter path (ADR 009) is untouched for repos that don't opt
  in.
- **Never auto-merge.** A human stays in the outer loop.

## Consequences

- New `repos.auto_heal_ci` column and `healing_sessions` / `healing_attempts`
  tables (migration 0008).
- `ForgeClient` gains `prHeadSha` (GitHub `headRefOid`, GitLab MR `sha`) to bind
  sessions and detect pushes.
- Healing sessions/attempts are surfaced read-only in the repo workspace.
