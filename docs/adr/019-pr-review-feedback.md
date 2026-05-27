# ADR 019: Opt-in PR review-feedback lifecycle

- **Status:** accepted
- **Date:** 2026-05-28

## Context

Drydock opens a PR and babysits its CI (ADR 009, ADR 017), but it does nothing
when a human reviewer leaves change requests on the PR. The reviewer's comments
sit untouched until someone manually re-engages the agent. We want Drydock to do
the *mechanical* iteration — apply the requested change, reply, resolve the
thread — while keeping the human firmly in the reviewer's seat. On a public repo
this must never act on arbitrary or bot comments, and must never auto-merge.

## Decision

Add an **opt-in**, per-repo PR review-feedback loop (`autoReviewFeedback`,
default off). It ingests review threads, acts only on trusted reviewers, walks
each comment through a small lifecycle, applies fixes in the PR's own worktree,
and reports back on the thread. It never merges.

### 1. Trusted-reviewer gating

Only feedback from a configured allowlist (`trustedReviewers`) is acted on. Bots
are always ignored — both an explicit `ignoredBots` list and the conventional
`[bot]` login suffix. An empty allowlist trusts nobody, so the feature stays
inert until a repo names specific reviewers.

### 2. Per-item lifecycle (state machine)

Each review thread is one item walking
`pending → queued → in_progress → resolved`, with branches `failed` (agent could
not carry out the change after the retry budget), `rejected` (out-of-scope), and
`flagged` (a question, handed to a human). A failed attempt with budget left
returns to `queued` for a later sweep. Items are classified deterministically
(no LLM): out-of-scope ("follow-up", "separate PR") → `rejected`; an imperative
change request → `actionable`; a purely interrogative comment → `question`.

### 3. Apply + report

Actionable items check out the PR branch in an isolated worktree, run the agent
against the single comment, commit, and push. Drydock then posts a status reply
on the thread, acknowledges the comment with a reaction (`EYES`), and resolves
the thread (GraphQL `resolveReviewThread`) when handled. Replies are
**marker-based and idempotent**: a hidden `<!-- drydock:review-feedback:<id> -->`
marker lets a prior reply be *updated in place* (`updatePullRequestReviewComment`)
instead of double-posting. An `includeProgressReplies` switch (default off) keeps
comment noise down.

### 4. Bounded merge-conflict repair (optional)

`autoResolveMergeConflicts` (default off) enables a bounded rebase-and-retry path
for trivial conflicts, stopping as soon as the branch is clean and giving up
after a small budget.

### 5. Hard budgets

`maxItemsPerSweep` (default 3) caps how many actionable items the agent applies
per sweep; `maxAttemptsPerItem` (default 2) flags an item for a human once spent.

### Unchanged invariants

- Off by default and independent of auto-triage / auto-processing / auto-heal.
- Review threads are a forge-optional surface: GitHub implements them via
  GraphQL; GitLab omits them and the feature is gated on their presence.
- **Never auto-merge.** A human stays in the outer loop.

## Consequences

- New `repos` columns (`auto_review_feedback`, `auto_resolve_merge_conflicts`,
  `include_progress_replies`, `trusted_reviewers`, `ignored_bots`) and a
  `review_feedback_items` table (migration 0009).
- `ForgeClient` gains optional review-thread methods (`listReviewThreads`,
  `replyToReviewThread`, `updateReviewComment`, `resolveReviewThread`,
  `reactToReviewComment`); `WorktreeManager` gains `prepareForBranch` to check
  out an existing PR branch.
- The feedback sweep runs as a low-priority step of the driver tick, so its
  forge calls yield the rate-limit budget to active jobs (ADR 018).
