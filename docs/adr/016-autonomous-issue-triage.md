# ADR 016: Opt-in autonomous issue triage & auto-processing

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Drydock only acted on issues a human had explicitly moved into the queue (the
per-repo `queueLabel`, managed on the issue board). For larger public repos that
is too manual: maintainers want Drydock to watch the repo, analyze incoming
issues, label them, and work the suitable ones automatically — but only where
they opt in, and without surrendering safety on a public repo where anyone can
open an issue (and inject instructions through it).

## Decision

Add two independently switchable, per-repo automation stages, **both off by
default**:

- **Auto-triage** (`autoTriageEnabled`) — analyze untriaged issues and apply
  labels.
- **Auto-processing** (`autoProcessEnabled`) — queue and work issues that pass a
  purely label-based gate.

### Label-gating, not complexity scoring

The "is this safe and well-specified enough to automate?" decision is expressed
through **labels**, never a fragile model-based complexity score. Triage may
*suggest* labels, but the gate the driver loop uses is strictly:

> **has a ready label AND no blocking label**

This keeps the system predictable and lets a human override anytime by editing
labels. Ready/blocking label sets are configurable per repo (`readyLabels`,
`blockingLabels`).

### Deterministic triage classifier

`src/lib/issues/triage.ts` classifies issues with **keyword rules**, not an LLM
call — deterministic, free, and testable. It reuses the existing
`evaluateIssue()` safety checks: risky issues (destructive commands, secrets,
exfiltration, privileged areas) receive a *blocking* label and are never
readied. An explanatory marker comment records what was applied and why.

### Output allowlist

Triage may only apply labels in `autoLabelWhitelist` **plus** the repo's own
configured ready/blocking labels — nothing else, and it only ever posts
comments. A content hash (`issues.triageHash`/`triagedAt`) skips re-triaging
unchanged issues, so triage doesn't loop or spam comments.

### Public-repo safety: author gate

`minAuthorAssociation` (`"approved"` by default) restricts both stages to issues
opened by owners/members/collaborators, mitigating prompt-injection from
arbitrary public authors. Set it to `"any"` to deliberately open up to public
participation. Author association comes from the forge: GitHub reports it
directly; GitLab does not, so GitLab issues are treated as unknown (not
approved) unless `minAuthorAssociation` is `"any"`.

### Attempt limit

`maxAttempts` (default 3) caps automated retries per issue, counted from jobs
that ended in `needs_human`/`aborted`. On exhaustion the issue is labelled with
the repo's `needsHumanLabel` and skipped — no infinite retry.

### Unchanged invariants

- The manual queue path is untouched (no regression); both paths coexist.
- All existing gates apply to auto-processed jobs: global pause, global and
  per-repo daily cost limits, `sequential` mode, `maxParallelJobs`.
- **Never auto-merge.** A human stays in the outer loop, consistent with the PR
  workflow.

## Consequences

- New `repos` columns + `issues.triageHash`/`triagedAt` (migration 0007).
- `ForgeClient` issues now carry optional `author`/`authorAssociation`.
- A freshly readied issue is picked up on the *next* tick (the candidate loop
  reads the API snapshot taken before triage applied labels), which is
  acceptable for a polling loop.
- GitLab author gating is conservative; documented for self-hosted users.
