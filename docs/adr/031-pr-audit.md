# ADR 031: Opt-in AI PR audit (read-only whole-PR review on the issue)

- **Status:** accepted
- **Date:** 2026-06-11

## Context

Drydock reacts to **human** review threads (ADR 019), checks issue/subtask
**acceptance** against the diff (ADR 027), and heals failing CI (ADR 017) — but
nothing proactively reviews a freshly opened PR the way Cursor Bugbot or
CodeRabbit do: correctness, security, test coverage, compatibility,
maintainability, and issue fit, before a human spends review time. Teams also
want the review artifact on the **issue thread**, where stakeholders already
track the work, and some teams want it written in a language other than
English. The capability cuts across the forge abstraction (comment upserts),
the agent provider abstraction (ADR 014), cost accounting (ADR 008), provider
limit handling (ADR 030), and the repo settings UX — hence this ADR.

## Decision

Add an **opt-in**, per-repo AI PR audit (`autoPrAudit`, default off): after a
PR opens (or on a manual job action / `run_pr_audit` MCP tool), a **read-only
one-shot agent** reviews the whole PR and an idempotent, structured review
comment is posted on the linked issue — optionally mirrored on the PR. The
audit is **advisory only**: it never merges, blocks, edits code, or changes
job state.

### 1. Pure prompt/parse/render core

`issues/pr-audit.ts` is pure (no I/O). The prompt covers six review dimensions
(correctness, security, tests, API/compatibility, maintainability, issue fit)
over the issue body, subtasks, CI conclusions, and the **length-capped** diff
(`MAX_AUDIT_DIFF_CHARS`, `MAX_AUDIT_ISSUE_BODY_CHARS`); oversized PRs still get
a partial audit plus a truncation notice. `parsePrAudit` validates the agent's
JSON (severities `blocker|major|minor|nit|praise`, recommendation
`approve|request_changes|comment`, findings with optional file/line anchors,
issue-coverage lists) with Zod and returns `null` on any malformation. The
renderer caps findings (`MAX_AUDIT_FINDINGS`), orders them by severity, and
always embeds a hidden job-scoped marker.

### 2. Locale-aware output, English UI

`prAuditLanguage` (simple or BCP 47 code, default `en`) only changes the
**review text** via an explicit prompt instruction; all UI strings, settings,
and markdown scaffolding stay English per project convention.

### 3. Per-repo agent/model selection with inherit semantics

`prAuditAgent` / `prAuditModel` are nullable: null inherits the repo's agent
and `defaultModel`. When only the agent is overridden, the model falls back to
that agent's catalog default — never a model the other CLI cannot run. The
one-shot is cost-tracked under type `pr_audit` (ADR 008's one-shot ledger).

### 4. Idempotent publication via forge comment upserts

The forge contract gains optional `listIssueComments` / `updateIssueComment`
(GitHub: `gh issue view --json comments` + the `updateIssueComment` GraphQL
mutation; GitLab: the notes REST API) and `commentPr` for the optional mirror.
A re-run finds the marker comment and edits it in place (ADR 019's pattern);
failure comments carry the same marker so a later success replaces them.
Forges without these methods degrade to plain `commentIssue` posts. Everything
posted passes through the secret redactor (ADR 023).

### 5. Failure containment and provider limits

The pass runs in a throwaway temp dir with a wall-clock cap
(`PR_AUDIT_TIMEOUT_MS`) and is best-effort by construction: invalid JSON, a
timeout, or a non-zero exit posts a short failure comment and records
`pr_audit_failed` — job state is never touched. A **waitable provider limit**
latches the agent (ADR 030) and the audit is **deferred silently** (no failure
comment, no retry queue in v1; re-run manually or it simply runs on the next
audited PR). While Drydock is globally paused the pass records
`pr_audit_skipped` and does nothing.

### 6. Orchestration placement

run-job invokes the audit after the `pr_opened` event and **after** the
cheaper ADR 027 verification pass, before the CI babysitter; the call is gated
on `repo.autoPrAudit` and wrapped so nothing can flip the job. Because every
trigger path goes through a Drydock job's own PR, only Drydock-authored PRs
are ever audited in v1 (the issue's `prAuditTrustedOnly` sketch is therefore
implicit, not a column).

## Consequences

- Bugs, security issues, and coverage gaps surface on the issue thread before
  a human review, in a consistent, severity-ranked format — advisory only, so
  the human merge decision (and CODEOWNERS) is untouched.
- Inert unless opted in; cost is bounded by the length caps, the single
  one-shot per audit, the timeout, and the findings cap on the comment.
- Re-runs are idempotent on the issue; the optional PR mirror is fire-and-once
  (not upserted) by design, keeping idempotency logic in one place.
- A provider-limit deferral means an audit can be silently skipped for that
  PR; the latch notification (ADR 030) makes the cause visible. A retry queue
  is a possible future refinement, as are inline review comments and
  storing parsed findings for dashboard analytics.
