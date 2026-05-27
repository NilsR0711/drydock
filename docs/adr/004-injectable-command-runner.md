# ADR 004: Injectable command runner for CLI subprocesses

- **Status:** accepted
- **Date:** 2026-05-27

## Context

The orchestrator shells out to the `gh` and `claude` CLIs via
`node:child_process`. Tests must never invoke the real CLIs (no network, no
external state), yet we want to exercise parsing and control flow.

## Decision

Define a `CommandRunner` type — `(cmd, args, cwd) => Promise<CommandResult>`.
Production wires `spawnRunner` (real `spawn`). `GhClient` and the Claude session
spawner accept a runner in their constructor, defaulting to `spawnRunner`. Tests
inject a fake runner returning canned stdout/stderr/exitCode.

## Consequences

- CLI wrappers are fully unit-testable without a network or installed CLIs.
- A single seam covers both `gh` and `claude` subprocess execution.
- Streaming (Phase 3/4) needs a separate streaming seam; this runner is for
  buffered request/response calls.
