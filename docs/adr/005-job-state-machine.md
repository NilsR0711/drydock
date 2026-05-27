# ADR 005: Explicit job state machine

- **Status:** accepted
- **Date:** 2026-05-27

## Context

A job moves through many states (queued → working → ci_running → ci_failed →
retrying → merged | needs_human | aborted, plus interrupted on recovery). Ad-hoc
status writes would allow illegal jumps (e.g. queued → merged) and make recovery
reasoning hard.

## Decision

Model transitions explicitly in `state-machine.ts` as an allow-list per state.
`transitionJob()` is the only writer of `jobs.status`; it calls `assertTransition`
and appends a `status` event to `job_events`, giving an auditable trail. Terminal
states (`merged`, `aborted`) have no successors.

## Consequences

- Illegal transitions throw `InvalidTransitionError` — caught early in tests.
- Every status change is logged as an event (replayable timeline).
- Adding a state means updating one table of transitions.
