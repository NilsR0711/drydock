# ADR 028: Opt-in release management for watched repos

- **Status:** accepted
- **Date:** 2026-05-29

## Context

Drydock's autonomy ends at merge: green CI on a PR is where its responsibility
stopped. Versioning and release notes — the manual tail of the issue → PR →
merge pipeline — are still done by hand. We want Drydock to optionally close the
loop for the repos it watches: evaluate the PRs merged since the last tag,
decide whether a release is warranted and the semver bump, generate release
notes, and publish a release. Cutting a public release is **hard to reverse**, so
this must be heavily gated, idempotent, and previewable, and it must not couple
the orchestrator to any one forge.

## Decision

Add an **opt-in** release-management subsystem, off by default and gated by both
a global kill-switch (`settings.releaseManagementEnabled`) and a per-repo flag
(`repos.releaseEnabled`). A merged PR (auto mode) or an operator (manual mode)
creates a **release run** that walks a state machine; the run is idempotent per
merge commit and previewable with no side effects.

### 1. Pure core (version + selection + evaluation)

`release/release.ts` is pure (no I/O): it selects the PRs merged since the last
release (`selectUnreleasedPrs`, fail-closed on an unparseable merge date), picks
the latest semver tag (`latestReleaseTag`), computes the next tag for a bump
(`nextReleaseTag`, building on `version/semver.ts`'s new `bumpSemver`), and
builds/strictly-parses the agent evaluation (`buildReleaseEvaluationPrompt` /
`parseReleaseEvaluation`, returning `null` on any malformed reply so callers fail
closed). The PR list is length-capped before prompting to bound cost.

### 2. Release-run state machine and persistence

`release/release-state.ts` defines `detected → evaluating → proposed →
publishing → published | skipped | error`. `published`/`skipped` are terminal;
`error` is **not** — a failed run is retried via `error → evaluating`.
`release/release-service.ts` persists runs in the `release_runs` table.
**Idempotency** is enforced two ways: a partial unique index on
`(repoId, triggerSha)` means one merge commit yields exactly one auto run, and
the driver never recreates a release whose tag already exists. The tag a run
chose is anchored on the run, so retrying an errored run never advances the
version past a release it may already have cut.

### 3. Forge release capability (gated on presence)

Three **optional** methods are added to the forge contract: `listReleases`,
`listMergedPrs`, and `createRelease`. They are implemented for GitHub via the
`gh` CLI; GitLab omits them for now, and the sweep/actions skip any forge that
does not implement all three — mirroring the optional review-thread methods
(ADR 019). A release is published at the **default-branch tip** (where the merged
code lives), not the PR head, which after a squash merge is not on the branch.

### 4. Preview, manual publish, and the background sweep

`orchestrator/release-driver.ts` holds the glue. `previewRelease` is a read-only
dry-run: it lists the prior tag, the included PRs, and a candidate version with
**no run persisted and no release created**. `publishRelease` walks a run through
the pipeline; the manual path **forces** a release (defaulting to a patch bump)
and bypasses the "should release?" gate but reuses the same evaluation for its
title/notes. `orchestrator/release-management-driver.ts` is the per-repo sweep,
wired into `driveTick` as another low-priority background sweep (alongside
review-feedback and deployment healing) and gated cheaply on the kill-switch and
per-repo opt-in. The evaluation runs as a one-shot agent in a throwaway temp dir
with a tight wall-clock timeout, routed through the repo's `AgentProvider`.

## Consequences

- Autonomy extends past merge to shipping for repos that explicitly opt in, with
  a global kill-switch as a hard off-switch.
- The auto path is idempotent: no duplicate run per merge commit and no duplicate
  release per tag, even across retries and overlapping sweeps.
- Preview has no side effects, so operators can inspect the proposed version and
  included PRs before anything is published.
- Manual publish reuses the evaluation pipeline, so the manual and auto paths
  share one code path and one notion of "what's in this release".
- A failed run lands in a retryable `error` state rather than leaving partial
  state, and the whole feature is inert unless both gates are on.
- GitLab release support and richer policies (e.g. release branches, prerelease
  channels, draft releases for human approval) are deferred; the optional-forge
  shape and the state machine leave room for them without core changes.
