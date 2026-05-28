# ADR 027: Opt-in post-PR verification pass

- **Status:** accepted
- **Date:** 2026-05-29

## Context

Today a PR can be opened that only partially addresses its issue, and nothing
checks acceptance criteria before a human reviews or before CI auto-merge. There
is no automated link between "PR created" and "issue actually addressed", so
partial work is only caught by a reviewer reading the diff. This is especially
acute for decomposed issues (ADR 020), where some subtasks may silently remain
unmet. We want an automated, read-only check that surfaces which criteria or
subtasks are still open right after a PR opens — without ever changing the merge
decision or risking corrupting tracked state.

## Decision

Add an **opt-in**, per-repo post-PR verification pass (`verifyPr`, default off).
After a PR is opened, a read-only one-shot agent is given the issue, its
subtasks, and the PR diff, and returns a strict JSON verdict per subtask. The
result updates subtask status and is summarised as an issue comment. It is
best-effort by construction: it never auto-merges, and any failure leaves all
state untouched.

### 1. Pure prompt/parse core

`issues/verify.ts` is pure (no I/O): it builds the read-only verification prompt
and strictly parses the agent's output. The issue body and diff are **length
capped** (`MAX_ISSUE_BODY_CHARS`, `MAX_DIFF_CHARS`) before prompting so a huge
issue or sprawling diff can neither blow the context window nor run up cost.
`parseVerification` extracts the JSON object, validates it with Zod, and returns
`null` on any failure (no JSON, malformed JSON, invalid status, wrong shape) so
the caller can leave state untouched.

### 2. Read-only one-shot in a throwaway dir

`orchestrator/verify-driver.ts` wraps the agent call. The CLI shape comes from
the repo's `AgentProvider` (Claude `-p`, Codex `exec`), mirroring issue
decomposition (ADR 014, 020). The pass runs in a **throwaway temp dir** with a
**tight wall-clock timeout** (`VERIFY_TIMEOUT_MS`, enforced by the runner). A
non-zero exit, unparseable output, or a thrown error (e.g. a timeout) all yield
`null`.

### 3. Best-effort verdict merge

Verdicts are matched to subtasks by ordinal. A `done` verdict advances the
subtask to done; `deferred` marks it deferred; `pending` leaves the subtask
untouched but is surfaced so the comment can flag what remains. Every transition
is wrapped against the subtask state machine, so an already-terminal subtask or
an unknown ordinal is silently ignored — the merge never throws and never
downgrades. The summary comment is passed through the secret redactor (ADR 023)
before posting.

### 4. Orchestration placement

run-job invokes the pass after the PR opens and the `pr_opened` event fires, and
before the CI babysitter. The call is gated on `repo.verifyPr` and wrapped so a
failure is recorded as a job event but never flips the job state or blocks the
merge path. A `prDiff(prNumber)` method is added to the forge abstraction
(GitHub `gh pr diff`, GitLab `/merge_requests/:iid/diffs`), best-effort and
returning an empty string on failure; an empty diff short-circuits the pass.

## Consequences

- Partial work is caught early: which subtasks remain `pending` is surfaced on
  the issue and reflected in tracked status, closing the loop with ADR 020.
- The feature is inert unless a repo opts in, and never changes the merge
  decision — a human still reviews every PR.
- Robust against failure by design: a non-JSON, timed-out, or erroring pass
  leaves subtask status exactly as it was, satisfying "never corrupt state".
- Cost is bounded by the length caps, the tight timeout, and the single one-shot
  call per opened PR.
- Verdicts are advisory: a `done` verdict advances a subtask even before merge.
  This is acceptable because it is evidence-based on the diff, and `done` is
  terminal; tightening this to gate on merge is a possible future refinement.
