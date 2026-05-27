# ADR 020: Opt-in decomposition of large issues into tracked subtasks

- **Status:** accepted
- **Date:** 2026-05-28

## Context

A big issue — "fix these five bugs", "implement X with A, B, and C" — is a poor
unit of autonomous work. A single agent run rarely lands all of it cleanly, and
when it stalls there is no record of which parts were done and which remain. We
want Drydock to optionally split such an issue into ordered subtasks it can work
and track individually, without changing how ordinary, single-purpose issues are
handled.

## Decision

Add an **opt-in**, per-repo decomposition stage (`autoDecompose`, default off).
It splits a large issue into ordered subtasks, surfaces them to the working
agent in order, and reflects progress on the issue and in the UI. It never
auto-merges and never affects non-decomposed issues.

### 1. Subtask model

A new `issue_subtasks` table stores one row per subtask: `repoId`,
`issueNumber`, `ordinal`, `title`, `status`, `bodyHash`, `createdAt`. The
`(repoId, issueNumber, ordinal)` triple is unique so a re-decomposition refreshes
the set deterministically. Each subtask walks a small lifecycle state machine,
mirroring the job and review-feedback machines:

```
pending → in_progress → done
```

with `skipped` (intentionally not done) and `deferred` (postponed, can return to
`pending`/`in_progress`) branches. `done` and `skipped` are terminal.

### 2. Decomposition (heuristic first, agent fallback)

`decompose.ts` is pure. A deterministic heuristic runs first and for free:
GitHub task-list items (`- [ ]` / `* [x]`) are preferred, then "Bug N —" / "Bug
N:" headings (with or without a markdown prefix). Only when the heuristic yields
fewer than two items does an **injectable one-shot agent generator** get a turn
at the prose, returning a JSON array of subtask titles. A generator that throws
or returns too few titles yields no decomposition — the issue is simply worked
whole. Keeping the generator injectable makes the whole module testable without
spawning an agent.

### 3. Idempotency keyed on the body hash

The issue row carries a `decomposedHash` — a djb2 hash (dependency-free, ADR
003) of the issue body the last time it was decomposed. `ensureSubtasks` skips
an issue whose body is unchanged, so neither the heuristic nor — crucially — the
paid agent fallback re-runs each sweep. The hash is stamped even when nothing
decomposes, so a non-decomposable issue is tried exactly once until its body
changes.

### 4. Processing integration

The decomposition sweep runs in the driver loop at **low priority** alongside
triage, bounded to work-candidate issues (queued or carrying a ready label) to
cap the per-issue detail fetch. On a fresh decomposition it leaves a single
comment listing the plan. When a job then runs a decomposed issue, run-job
appends the ordered subtask checklist to the agent prompt with an instruction to
work them top to bottom, marks the subtasks `in_progress` as the job starts, and
marks them `done` once the job merges. Concurrency stays low because repos are
sequential by default (one in-flight job per repo).

## Consequences

- Large issues become trackable: the planned subtasks are visible on the issue
  and in the detail view, and their status advances as work proceeds.
- The feature is inert unless a repo opts in, and ordinary issues are wholly
  unaffected (no subtasks → no prompt change, no extra calls).
- The agent fallback is bounded by the body-hash idempotency and the
  work-candidate gate, so it cannot run away with cost.
- Progress is currently tracked at job granularity (all subtasks move together
  as the single job runs and merges); per-subtask isolated runs — each its own
  worktree/PR — are a deliberate future step, not part of this change.
