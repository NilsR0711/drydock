# ADR 036: Babysit arbitrary PRs added by URL

- **Status:** accepted
- **Date:** 2026-06-19

## Context

Drydock was strictly **issue → PR**: it only ever babysat PRs it opened itself,
bound to a `jobs` row that owns a `drydock/` branch. There was no way to point
Drydock at an *existing* pull request — one a human (or another bot) authored —
and have it watch CI, run review feedback, heal failing checks, or hand off to a
human (issue #293).

Reusing the issue→PR pipeline directly is a poor fit: those flows are keyed on a
`jobs` row, an originating issue, and a branch we created. An externally-authored
PR has none of these guarantees — it may be a fork, its branch is not ours, and
it must stay tracked regardless of whether the repo's *issues* are being watched.

Two policy questions had to be answered up front:

- **Auto-merge for externally-authored PRs?** Default **off**, opt-in per PR.
- **Edits on a branch we don't own (review-feedback / CI-heal)?** Push only when
  the branch is in the base repo; for forks, hand off to a human — never
  force-update or delete a branch we don't control.

## Decision

Add a **tracking record decoupled from any issue/job** plus a **dedicated
driver-loop sweep** that babysits it, reusing the existing building blocks
(`classifyChecks`, the trusted-reviewer feedback engine, the one-shot agent
runner) rather than the job pipeline.

### 1. `tracked_prs` table — the decoupled record

A `tracked_prs` row (repo, PR number, URL, platform, head/base slug, fork flag,
ownership, `autoMerge`, status, …) is the source of truth. Its own lifecycle —
`tracking → needs_human | merged | closed | stopped` — is independent of the
`jobs` state machine. `reviewFeedbackItems` gained a nullable `job_id` and a new
`tracked_pr_id` so the existing review-feedback lifecycle persists against either
owner.

### 2. A sweep, not a long-lived job

`driveTrackedPrs` reconciles every actively-tracked PR each tick: it mirrors the
live head/fork/ownership state from `forge.prInfo`, detects an external
merge/close, parks conflicts for a human, auto-heals failing CI on owned
branches, runs review feedback, and auto-merges only when the PR is opted in,
owned, clean and green. A sweep (vs. a job holding a worker slot) suits a PR that
may live for days with auto-merge off.

### 3. The ownership guardrail

A tracked PR is **owned** only when its head branch lives in the base repo
(`!isCrossRepository`). Agent work (CI-heal, feedback edits) and auto-merge are
gated on ownership; a fork PR is watched and handed off to a human but never
pushed to. The sweep never deletes or force-updates a branch.

### 4. Decoupled cost accounting

Tracked-PR agent work (CI-heal, feedback edits) has no job to bill to, so it runs
through the one-shot agent path (`runOneShotAndRecordCost`, cost recorded to
`oneShotCosts` scoped to the repo) in an isolated worktree on the PR branch.

### 5. Entry points

"Add PR by URL" is exposed on the repo dashboard (a panel with the live tracked
list) and over MCP (`track_pr`, `list_tracked_prs`, `untrack_pr`). The URL is
parsed (`parsePrUrl`, GitHub + GitLab) and validated against the repo's real PR
via `forge.prInfo` before tracking. Direct-URL PRs are **not** gated on the
repo's issue watch scope.

## Consequences

- Drydock widens from an "issue orchestrator" to "also a PR babysitter" without
  touching the issue→PR pipeline; the two share forge/feedback/heal primitives.
- Externally-authored PRs are safe by default: never merged unless explicitly
  opted in, never pushed to on a fork, never branch-deleted.
- A second tracking lifecycle exists alongside `jobs`; the dashboard and sweep
  must each understand both. Auto-merge of fork PRs and on-fork edits are out of
  scope (handed to a human) until push access to forks is modelled.
